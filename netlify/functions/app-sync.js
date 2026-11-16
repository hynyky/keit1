import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const roomStore = () => getStore({ name: "cb-shared-room", consistency: "strong" });
const imageStore = () => getStore({ name: "cb-shared-images", consistency: "strong" });
const sysStore = () => getStore({ name: "cb-shared-sys", consistency: "strong" });

const ROOM_KEY = "baoanhkiet_main";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest();
}

function checkPassword(inputPass) {
  const expected = process.env.APP_PASSWORD || "baoanhkiet";
  return crypto.timingSafeEqual(sha256(inputPass), sha256(expected));
}

async function getSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const sys = sysStore();
  let secret = await sys.get("hmac_secret");
  if (!secret) {
    secret = crypto.randomBytes(32).toString("hex");
    await sys.set("hmac_secret", secret);
  }
  return secret;
}

async function signToken(payload) {
  const secret = await getSecret();
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

async function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const secret = await getSecret();
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";

  try {
    // 1. Tải ảnh đồ ăn (chỉ người có mật khẩu đúng mới xem được)
    if (req.method === "GET" && action === "image") {
      const token = url.searchParams.get("token") || "";
      const imgId = url.searchParams.get("id") || "";
      const session = await verifyToken(token);
      if (!session || !imgId.startsWith("img_")) {
        return new Response("Forbidden", { status: 403 });
      }
      const buf = await imageStore().get(imgId, { type: "arrayBuffer" });
      if (!buf) return new Response("Not Found", { status: 404 });
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "private, max-age=86400"
        }
      });
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const body = await req.json().catch(() => ({}));

    // 2. Kiểm tra mật khẩu ("baoanhkiet") để mở khóa web
    if (action === "unlock") {
      const pass = String(body.password || "").trim();
      const roleName = String(body.roleName || "Thành viên").trim().slice(0, 30) || "Thành viên";
      if (!checkPassword(pass)) {
        return json({ error: "Mật khẩu không đúng!" }, 401);
      }
      const token = await signToken({ roleName, iat: Date.now() });
      return json({ ok: true, token, roleName });
    }

    // Xác thực token cho mọi yêu cầu đồng bộ
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const session = await verifyToken(token);
    if (!session) return json({ error: "Chưa mở khóa mật khẩu" }, 401);

    const store = roomStore();

    // 3. Kiểm tra nhanh có cập nhật mới từ máy kia không
    if (action === "check") {
      const room = await store.get(ROOM_KEY, { type: "json" });
      return json({ version: room?.version || 0 });
    }

    // 4. Lấy toàn bộ dữ liệu + ảnh bữa ăn mới nhất
    if (action === "get") {
      const room = (await store.get(ROOM_KEY, { type: "json" })) || {
        version: 0,
        updatedByName: "",
        deviceId: "",
        storage: {},
        mealFeed: []
      };
      return json(room);
    }

    // 5. Lưu toàn bộ trạng thái web (cân nặng, nhật ký, tủ lạnh, thực đơn)
    if (action === "save") {
      const room = (await store.get(ROOM_KEY, { type: "json" })) || {
        version: 0, storage: {}, mealFeed: []
      };
      const now = Date.now();
      room.version = now;
      room.updatedByName = session.roleName;
      room.deviceId = body.deviceId || "";
      room.storage = body.storage || {};
      await store.setJSON(ROOM_KEY, room);
      return json({ ok: true, version: now });
    }

    // 6. Đăng ảnh đồ ăn mới lên tức thì
    if (action === "postMeal") {
      const base64 = String(body.imageBase64 || "");
      const title = String(body.title || "Vừa chụp bữa ăn").trim().slice(0, 140);
      const note = String(body.note || "").trim().slice(0, 400);

      let imageId = "";
      if (base64.includes("base64,")) {
        const raw = base64.split("base64,")[1];
        const buf = Buffer.from(raw, "base64");
        if (buf.length > 2 * 1024 * 1024) {
          return json({ error: "Ảnh quá lớn" }, 400);
        }
        imageId = `img_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        await imageStore().set(imageId, buf);
      }

      const room = (await store.get(ROOM_KEY, { type: "json" })) || {
        version: 0, storage: {}, mealFeed: []
      };
      if (!Array.isArray(room.mealFeed)) room.mealFeed = [];

      const entry = {
        id: "m_" + Date.now(),
        authorName: session.roleName,
        time: Date.now(),
        title,
        note,
        imageId
      };
      room.mealFeed.unshift(entry);
      room.mealFeed = room.mealFeed.slice(0, 30);
      room.version = Date.now();
      room.updatedByName = session.roleName;
      room.deviceId = body.deviceId || "";

      await store.setJSON(ROOM_KEY, room);
      return json({ ok: true, entry, version: room.version, mealFeed: room.mealFeed });
    }

    // 7. Cập nhật tên món / calo từ AI vào tấm ảnh vừa đăng
    if (action === "updateMealNote") {
      const mealId = body.mealId;
      const room = await store.get(ROOM_KEY, { type: "json" });
      if (!room || !Array.isArray(room.mealFeed)) return json({ ok: false });
      const item = room.mealFeed.find((x) => x.id === mealId);
      if (item) {
        if (body.title) item.title = String(body.title).slice(0, 140);
        if (body.note) item.note = String(body.note).slice(0, 400);
        room.version = Date.now();
        room.updatedByName = session.roleName;
        room.deviceId = body.deviceId || "";
        await store.setJSON(ROOM_KEY, room);
      }
      return json({ ok: true, version: room.version, mealFeed: room.mealFeed });
    }

    // 8. Xóa một ảnh bữa ăn nếu chụp nhầm
    if (action === "deleteMeal") {
      const mealId = body.mealId;
      const room = await store.get(ROOM_KEY, { type: "json" });
      if (!room || !Array.isArray(room.mealFeed)) return json({ ok: false });
      const target = room.mealFeed.find((x) => x.id === mealId);
      if (target?.imageId) {
        await imageStore().delete(target.imageId).catch(() => {});
      }
      room.mealFeed = room.mealFeed.filter((x) => x.id !== mealId);
      room.version = Date.now();
      room.updatedByName = session.roleName;
      room.deviceId = body.deviceId || "";
      await store.setJSON(ROOM_KEY, room);
      return json({ ok: true, version: room.version, mealFeed: room.mealFeed });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: "Lỗi máy chủ: " + err.message }, 500);
  }
};

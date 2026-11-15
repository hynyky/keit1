export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const apiKey = (
    (typeof Netlify !== "undefined" && Netlify.env.get("GEMINI_API_KEY")) ||
    process.env.GEMINI_API_KEY ||
    ""
  ).trim();

  if (!apiKey) {
    return Response.json(
      { error: { message: "Chưa cài đặt GEMINI_API_KEY trong Biến môi trường của Netlify." } },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: { message: "Dữ liệu gửi lên không hợp lệ." } }, { status: 400 });
  }

  const model = "gemini-3.5-flash-lite";
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: body.parts || [] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: body.maxTok || 2500,
          thinkingConfig: { thinkingLevel: "minimal" },
        },
      }),
    }
  );

  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { "content-type": "application/json" },
  });
};
// Test script for bing-edge-api

const BASE_URL = "http://127.0.0.1:8388";

async function runTests() {
  console.log("=== Testing bing-edge-api ===");

  // 1. Health check
  console.log("\n[1] Testing GET /health");
  const healthRes = await fetch(`${BASE_URL}/health`);
  console.log("Status:", healthRes.status);
  const healthJson = await healthRes.json();
  console.log("Response:", JSON.stringify(healthJson, null, 2));

  // 2. Models list
  console.log("\n[2] Testing GET /v1/models");
  const modelsRes = await fetch(`${BASE_URL}/v1/models`);
  const modelsJson = await modelsRes.json();
  console.log("Models:", modelsJson.data.map((m) => m.id));

  // 3. OpenAI Chat Completions (Non-streaming)
  console.log("\n[3] Testing POST /v1/chat/completions (Non-streaming)");
  const chatRes = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "bing-copilot",
      messages: [
        { role: "system", content: "Jawab singkat dalam 1 kalimat padat." },
        { role: "user", content: "Apa itu Node.js?" }
      ],
      stream: false
    })
  });
  console.log("Chat Status:", chatRes.status);
  const chatJson = await chatRes.json();
  console.log("Assistant Reply:\n", chatJson.choices?.[0]?.message?.content);

  // 4. OpenAI Chat Completions (Streaming)
  console.log("\n[4] Testing POST /v1/chat/completions (Streaming SSE)");
  const streamRes = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "bing-copilot",
      messages: [{ role: "user", content: "Hitung 1 sampai 5" }],
      stream: true
    })
  });
  console.log("Stream Status:", streamRes.status);
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let streamOutput = "";
  let chunkCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ") && line !== "data: [DONE]") {
        try {
          const parsed = JSON.parse(line.slice(6));
          const delta = parsed.choices?.[0]?.delta?.content || "";
          streamOutput += delta;
          chunkCount++;
        } catch {}
      }
    }
  }
  console.log(`Received ${chunkCount} chunks. Streamed output:\n${streamOutput.slice(0, 200)}...`);

  // 5. Bing Web Search
  console.log("\n[5] Testing GET /v1/search");
  const searchRes = await fetch(`${BASE_URL}/v1/search?q=Anthropic+Claude&count=3`);
  const searchJson = await searchRes.json();
  console.log(`Found ${searchJson.count} search items. Top item:`, searchJson.data?.[0]?.title);

  // 6. Bing Image Search
  console.log("\n[6] Testing GET /v1/images/search");
  const imgRes = await fetch(`${BASE_URL}/v1/images/search?q=cyberpunk+city&count=2`);
  const imgJson = await imgRes.json();
  console.log(`Found ${imgJson.count} images. Top image URL:`, imgJson.data?.[0]?.url);

  console.log("\n=== ALL TESTS COMPLETED SUCCESSFULLY ===");
}

runTests().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});

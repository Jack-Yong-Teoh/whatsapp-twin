from fastapi import FastAPI, Request
import httpx
import os
import pathlib

app = FastAPI()

AI_API_URL = os.getenv("AI_API_URL")
AI_API_KEY = os.getenv("AI_API_KEY")
AI_MODEL = os.getenv("AI_MODEL")
PERSONA_NAME = os.getenv("PERSONA_NAME")

# Dynamic prompt path
PERSONA_FILE_PATH = pathlib.Path(__file__).parent / "config" / "persona.md"

def load_system_prompt() -> str:
    if PERSONA_FILE_PATH.exists():
        return PERSONA_FILE_PATH.read_text(encoding="utf-8").strip()
    return ""

@app.post("/chat-context")
async def process_context(request: Request):
    payload = await request.json()
    chat_history = payload.get("history", [])
    
    # Compress history token footprint
    cleaned_transcript = []
    for msg in chat_history:
        sender = msg.get("sender", "Unknown")
        text = msg.get("text", "").strip()
        if text and "[Media]" not in text:
            cleaned_transcript.append(f"{sender}: {text[:150]}")
            
    transcript_str = "\n".join(cleaned_transcript)
    system_prompt = load_system_prompt()
    if system_prompt:
        system_prompt = system_prompt.replace("{{PERSONA_NAME}}", PERSONA_NAME)

    headers = {"Authorization": f"Bearer {AI_API_KEY}"}
    ai_payload = {
        "model": AI_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Context:\n{transcript_str}\n\nReply as {PERSONA_NAME}:"}
        ]
    }

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(AI_API_URL, json=ai_payload, headers=headers, timeout=12.0)
            response.raise_for_status()
            data = response.json()
            reply = data["choices"][0]["message"]["content"]
            return {"reply": reply.strip()}
    except httpx.HTTPStatusError as e:
        print(f"Error calling AI API: HTTP {e.response.status_code} - {e.response.text}")
        return {"reply": "api acting up bro, hold on"}
    except Exception as e:
        print(f"Error calling AI API: {str(e)}")
        return {"reply": "api acting up bro, hold on"}
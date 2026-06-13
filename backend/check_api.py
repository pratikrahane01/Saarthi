import os
from dotenv import load_dotenv
from groq import Groq

# Load environment variables from .env
load_dotenv()

api_key = os.environ.get("GROQ_API_KEY")

if not api_key:
    print("[ERROR] GROQ_API_KEY is not set in the environment or .env file.")
    exit(1)

print("[INFO] GROQ_API_KEY found. Initializing Groq client...")

try:
    client = Groq(api_key=api_key)
    
    print("[INFO] Groq client initialized. Testing completion...")
    
    response = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[
            {"role": "user", "content": "Hello! Please reply with a single word: 'WORKING'."}
        ],
        temperature=0.0,
        max_tokens=10
    )
    
    reply = response.choices[0].message.content.strip()
    print(f"[SUCCESS] Received response from Groq API: '{reply}'")
    
    if "WORKING" in reply.upper():
        print("[SUCCESS] The Groq API key is valid and working properly.")
    else:
        print("[WARNING] Received an unexpected response, but the API key is active.")

except Exception as e:
    print(f"[ERROR] Failed to communicate with Groq API. Error: {e}")
    exit(1)

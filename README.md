
# 🌉 Speak-Bridge

### Breaking Communication Barriers Through AI

Speak-Bridge is an AI-powered communication platform designed to bridge the gap between sign language users and non-sign language users. It combines hand gesture recognition, voice input, text messaging, and speech synthesis to make everyday communication more accessible.

---

## 🚀 Features

- **Real-Time Sign Recognition:** Uses webcam input and MediaPipe Hands to detect and recognize supported hand gestures.
- **Two-Hand Gesture Recognition:** Supports selected two-hand gestures such as MORE and SAME.
- **Sign Trainer:** Allows users to record and train custom motion-based gestures.
- **Voice-to-Text:** Converts spoken words into text using browser speech recognition, with an optional transcription fallback.
- **Text-to-Speech:** Converts typed messages into speech using ElevenLabs.
- **Text Messaging:** Provides a simple text-based communication alternative.
- **Sign Avatar:** Displays visual hand representations for supported signs and fingerspelled letters.
- **Recognition Feedback:** Allows users to flag incorrect gesture recognition for review.

---

## 🛠️ Tech Stack

### Frontend
- React 19
- Vite
- Tailwind CSS
- MediaPipe Hands
- Web Speech API
- Vitest

### Backend
- Python
- FastAPI
- Uvicorn
- ElevenLabs API
- NeuralSeek integration (optional)

---

## 📂 Project Structure

```text
speak-bridge/
│
├── public/
│   └── mediapipe/
│
├── src/
│   ├── App.jsx
│   ├── Camera.jsx
│   ├── VoiceInput.jsx
│   ├── SignTrainer.jsx
│   ├── SignAvatar.jsx
│   ├── gestureClassifier.js
│   ├── dynamicSignTrainer.js
│   └── ...
│
├── server/
│   ├── main.py
│   ├── requirements.txt
│   ├── requirements-dev.txt
│   ├── eleven_labs_client.py
│   └── neuralseek_client.py
│
├── Dockerfile
├── package.json
├── package-lock.json
├── vite.config.js
├── index.html
└── README.md
```

---

## ⚙️ Installation & Setup

### Prerequisites

- Python 3.10+
- Node.js 20+
- npm
- Git

### 1. Clone the Repository

```bash
git clone https://github.com/Madhusmita9015/speak-bridge.git
cd speak-bridge
```

### 2. Set Up the Backend

Navigate to the server directory:

```bash
cd server
```

Create a virtual environment:

```bash
python -m venv .venv
```

Activate it on Windows:

```powershell
.venv\Scripts\activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

Create the environment file:

```powershell
Copy-Item .env.example .env
```

Start the backend:

```bash
python main.py
```

Backend URL:

`http://localhost:8000`

### 3. Set Up the Frontend

Open another terminal in the project root:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Frontend URL:

`http://localhost:5173`

---

## 🔑 Environment Variables

Some advanced features require API credentials.

| Variable | Description |
|---|---|
| `ELEVENLABS_API_KEY` | Enables speech synthesis and audio transcription |
| `ELEVENLABS_VOICE_ID` | Specifies the ElevenLabs voice |
| `NEURALSEEK_API_KEY` | Enables optional NeuralSeek integration |
| `NEURALSEEK_AGENT_ID` | NeuralSeek agent identifier |
| `NEURALSEEK_AGENT_NAME` | NeuralSeek agent name |
| `NEURALSEEK_STREAM_URL` | NeuralSeek streaming endpoint |
| `ALLOWED_ORIGINS` | Configures allowed frontend origins |
| `VITE_API_BASE` | Optional frontend API base URL |

**Note:** API keys should always be stored in environment variables. Never commit `.env` files or expose credentials publicly.

---

## ☁️ Deployment

Speak-Bridge supports Docker-based deployment.

The included Dockerfile builds the React frontend and packages it with the FastAPI backend.

### Deploying on Render

1. Push the project to GitHub.
2. Create a new Web Service on Render.
3. Connect the Speak-Bridge repository.
4. Select Docker as the runtime.
5. Keep the Root Directory empty.
6. Use the default Dockerfile path: `./Dockerfile`.
7. Configure the required environment variables.
8. Set the health check path to `/health`.
9. Deploy the application.

The backend serves the production frontend and API from the same origin.

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Checks backend health |
| GET | `/api/config` | Checks available integrations |
| POST | `/api/speak` | Converts text into speech |
| POST | `/api/transcribe` | Transcribes uploaded audio |
| POST | `/api/feedback` | Records recognition feedback |
| POST | `/api/stream/frame` | Handles frame upload |
| POST | `/api/stream/frame-sse` | Streams frames to optional NeuralSeek integration |

---

## 🧪 Testing

Run frontend tests:

```bash
npm test
```

Run linting:

```bash
npm run lint
```

Build the frontend:

```bash
npm run build
```

Run backend tests:

```bash
cd server
pip install -r requirements-dev.txt
pytest
```

---

## ⚠️ Current Limitations

- The built-in gesture classifier supports a limited set of static gestures, not the complete ASL vocabulary.
- Facial expressions and non-manual ASL grammar are not interpreted.
- Custom motion gestures require user-provided training examples.
- Custom gesture templates are stored locally in the browser.
- Voice features requiring ElevenLabs need valid API credentials.
- Webcam access requires HTTPS in production or localhost during development.
- NeuralSeek functionality is optional and requires configuration.

---

## 🔒 Privacy

- Hand landmark detection and built-in gesture classification run in the browser.
- Custom gesture templates are stored in browser local storage.
- Audio submitted for transcription is processed through ElevenLabs when that integration is enabled.
- Frames may be sent to NeuralSeek when its optional fallback is enabled.
- Recognition feedback is stored by the backend.

---

## 🎯 Project Objective

The primary objective of Speak-Bridge is to make communication more inclusive by combining artificial intelligence, computer vision, and speech technologies.

By providing multiple communication methods through a unified interface, the project aims to reduce communication barriers and improve accessibility.

---

## 👨‍💻 Built With

React • Python • FastAPI • MediaPipe • Vite • ElevenLabs • NeuralSeek

**Speak-Bridge — Communication Without Barriers.** 🌉

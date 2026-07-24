# Real-Time Chat Application

Full-stack WebSocket chat application with rooms, typing indicators, message history, and presence tracking.

## Features

- Real-time messaging with WebSocket
- Multiple chat rooms
- Typing indicators
- Online/offline presence
- Message history with MongoDB
- User authentication (JWT)
- File/image sharing
- Emoji support
- Message search
- Unread message counts

## Tech Stack

- **Backend**: Node.js, Socket.IO, Express
- **Database**: MongoDB (messages), Redis (presence, pub/sub)
- **Frontend**: Vanilla JS (no framework bloat)
- **Auth**: JWT with refresh tokens
- **Testing**: Jest, Socket.IO client

## Quick Start

```bash
# Install dependencies
npm install

# Start MongoDB and Redis
docker-compose up -d mongodb redis

# Seed demo users
npm run seed

# Start server
npm run dev

# Open http://localhost:3000
```

## WebSocket Events

### Client → Server
- `message:send` - Send message to room
- `message:typing` - Typing indicator
- `room:join` - Join a room
- `room:leave` - Leave a room
- `user:status` - Update status

### Server → Client
- `message:new` - New message received
- `message:history` - Message history
- `user:typing` - User typing indicator
- `user:joined` - User joined room
- `user:left` - User left room
- `user:online` - User came online
- `user:offline` - User went offline

## API Endpoints

- `POST /api/auth/register` - Register
- `POST /api/auth/login` - Login
- `GET /api/rooms` - List rooms
- `POST /api/rooms` - Create room
- `GET /api/messages/:roomId` - Get message history
- `GET /api/users/online` - Get online users

## Docker

```bash
docker-compose up -d
```

## License

MIT

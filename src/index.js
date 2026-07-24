const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const Redis = require('ioredis');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const winston = require('winston');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'chat-app' },
  transports: [new winston.transports.Console({ format: winston.format.simple() })]
});

// MongoDB
const MessageSchema = new mongoose.Schema({
  roomId: { type: String, required: true, index: true },
  userId: { type: String, required: true },
  username: { type: String, required: true },
  content: { type: String, required: true },
  type: { type: String, enum: ['text', 'image', 'file', 'system'], default: 'text' },
  fileUrl: String,
  reactions: [{ emoji: String, userId: String }],
  edited: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false }
}, { timestamps: true });

MessageSchema.index({ roomId: 1, createdAt: -1 });
MessageSchema.index({ content: 'text' });

const Message = mongoose.model('Message', MessageSchema);

const RoomSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  description: String,
  type: { type: String, enum: ['public', 'private', 'dm'], default: 'public' },
  members: [{ type: String }],
  owner: String,
  lastMessage: {
    content: String,
    username: String,
    timestamp: Date
  }
}, { timestamps: true });

const Room = mongoose.model('Room', RoomSchema);

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  avatar: String,
  status: { type: String, enum: ['online', 'offline', 'away'], default: 'offline' },
  lastSeen: Date
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

// Redis
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379')
});

const redisSub = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379')
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.static('public'));

// Auth middleware
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    req.user = decoded;
    next();
  } catch {
    res.status(403).json({ error: 'Invalid token' });
  }
};

// REST API
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'chat-app', timestamp: new Date().toISOString() });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const bcrypt = require('bcryptjs');

    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) return res.status(409).json({ error: 'User already exists' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ username, email, passwordHash });

    const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });

    res.status(201).json({ user: { id: user._id, username, email }, token });
  } catch (err) {
    logger.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const bcrypt = require('bcryptjs');

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });

    res.json({ user: { id: user._id, username: user.username, email }, token });
  } catch (err) {
    logger.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/rooms', authenticate, async (req, res) => {
  try {
    const rooms = await Room.find({ type: 'public' }).sort({ name: 1 });
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list rooms' });
  }
});

app.post('/api/rooms', authenticate, async (req, res) => {
  try {
    const { name, description, type } = req.body;
    const room = await Room.create({
      name, description, type,
      owner: req.user.id,
      members: [req.user.id]
    });
    res.status(201).json(room);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create room' });
  }
});

app.get('/api/messages/:roomId', authenticate, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { limit = 50, before } = req.query;

    const query = { roomId, deleted: false };
    if (before) query.createdAt = { $lt: new Date(before) };

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json(messages.reverse());
  } catch (err) {
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

app.get('/api/users/online', authenticate, async (req, res) => {
  try {
    const onlineUsers = await redis.smembers('online:users');
    const users = await User.find({ _id: { $in: onlineUsers } })
      .select('username status lastSeen')
      .lean();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get online users' });
  }
});

// WebSocket handling
const connectedUsers = new Map(); // socketId -> { userId, username, rooms }

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    socket.user = decoded;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', async (socket) => {
  const { id: userId, username } = socket.user;
  logger.info(`User connected: ${username} (${socket.id})`);

  // Track connected user
  connectedUsers.set(socket.id, { userId, username, rooms: [] });

  // Add to online users
  await redis.sadd('online:users', userId);
  await User.findByIdAndUpdate(userId, { status: 'online', lastSeen: new Date() });

  // Broadcast online status
  io.emit('user:online', { userId, username });

  // Send online users list
  const onlineUsers = await redis.smembers('online:users');
  socket.emit('users:online', onlineUsers);

  // Join room
  socket.on('room:join', async (roomId) => {
    socket.join(roomId);
    const user = connectedUsers.get(socket.id);
    if (user) user.rooms.push(roomId);

    // Add user to room members
    await Room.findByIdAndUpdate(roomId, { $addToSet: { members: userId } });

    // Broadcast
    io.to(roomId).emit('user:joined', { userId, username, roomId });
    logger.info(`${username} joined room ${roomId}`);
  });

  // Leave room
  socket.on('room:leave', async (roomId) => {
    socket.leave(roomId);
    const user = connectedUsers.get(socket.id);
    if (user) user.rooms = user.rooms.filter(r => r !== roomId);

    await Room.findByIdAndUpdate(roomId, { $pull: { members: userId } });

    io.to(roomId).emit('user:left', { userId, username, roomId });
    logger.info(`${username} left room ${roomId}`);
  });

  // Send message
  socket.on('message:send', async (data) => {
    try {
      const { roomId, content, type = 'text', fileUrl } = data;

      const message = await Message.create({
        roomId, userId, username, content, type, fileUrl
      });

      // Update room last message
      await Room.findByIdAndUpdate(roomId, {
        lastMessage: { content, username, timestamp: new Date() }
      });

      // Publish to Redis for multi-instance support
      await redis.publish('chat:message', JSON.stringify({
        roomId, message: message.toObject()
      }));

      io.to(roomId).emit('message:new', message.toObject());
    } catch (err) {
      logger.error('Send message error:', err);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Typing indicator
  socket.on('message:typing', (data) => {
    const { roomId, isTyping } = data;
    socket.to(roomId).emit('user:typing', { userId, username, roomId, isTyping });
  });

  // Message reaction
  socket.on('message:react', async (data) => {
    try {
      const { messageId, emoji } = data;
      const message = await Message.findById(messageId);
      if (!message) return;

      const existingReaction = message.reactions.find(
        r => r.emoji === emoji && r.userId === userId
      );

      if (existingReaction) {
        message.reactions = message.reactions.filter(
          r => !(r.emoji === emoji && r.userId === userId)
        );
      } else {
        message.reactions.push({ emoji, userId });
      }

      await message.save();
      io.to(message.roomId).emit('message:updated', message.toObject());
    } catch (err) {
      logger.error('Reaction error:', err);
    }
  });

  // Search messages
  socket.on('message:search', async (data) => {
    try {
      const { roomId, query } = data;
      const messages = await Message.find({
        roomId,
        content: { $regex: query, $options: 'i' },
        deleted: false
      }).limit(20).sort({ createdAt: -1 });

      socket.emit('message:results', messages);
    } catch (err) {
      logger.error('Search error:', err);
    }
  });

  // Disconnect
  socket.on('disconnect', async () => {
    logger.info(`User disconnected: ${username} (${socket.id})`);

    connectedUsers.delete(socket.id);

    // Check if user has other connections
    let hasOtherConnections = false;
    connectedUsers.forEach((user) => {
      if (user.userId === userId) hasOtherConnections = true;
    });

    if (!hasOtherConnections) {
      await redis.srem('online:users', userId);
      await User.findByIdAndUpdate(userId, { status: 'offline', lastSeen: new Date() });
      io.emit('user:offline', { userId, username });
    }
  });
});

// Redis subscriber for multi-instance support
redisSub.subscribe('chat:message');
redisSub.on('message', (channel, message) => {
  if (channel === 'chat:message') {
    const data = JSON.parse(message);
    io.to(data.roomId).emit('message:new', data.message);
  }
});

// Connect to MongoDB and start server
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/chat')
  .then(() => {
    logger.info('Connected to MongoDB');
    server.listen(PORT, () => {
      logger.info(`Chat server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    logger.error('MongoDB connection failed:', err);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  server.close(() => {
    mongoose.disconnect();
    redis.disconnect();
    redisSub.disconnect();
    process.exit(0);
  });
});

module.exports = { app, server, io };

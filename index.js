const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 5000;

app.use(cors());

// Health check for Render
app.get('/', (req, res) => {
    res.json({ status: 'WikiSprint Backend is running!' });
});

// Fetch a Wikipedia page by title
app.get('/api/page/:title', async (req, res) => {
    try {
        const title = req.params.title;
        const url = `https://tr.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text|displaytitle|sections&format=json&origin=*`;
        
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('Wikipedia API error');
        }
        const data = await response.json();
        
        if (data.error) {
            return res.status(404).json({ error: data.error.info });
        }

        res.json({
            title: data.parse.title,
            displaytitle: data.parse.displaytitle,
            text: data.parse.text['*'],
            sections: data.parse.sections || []
        });
    } catch (error) {
        console.error('Error fetching Wikipedia page:', error);
        res.status(500).json({ error: 'Internal server error fetching page' });
    }
});

// MULTIPLAYER STATE (In-Memory)
const rooms = {};

const generateRoomId = () => Math.random().toString(36).substring(2, 8).toUpperCase();

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Create a room
    socket.on('create-room', ({ playerName }) => {
        const roomId = generateRoomId();
        
        rooms[roomId] = {
            roomId,
            hostId: socket.id,
            players: [
                { id: socket.id, name: playerName, currentPage: null, clicks: 0, isFinished: false, timeElapsed: null }
            ],
            startPage: null,
            targetPage: null,
            gameMode: 'speed', // 'speed' or 'clicks'
            gameStarted: false,
            startTime: null
        };
        
        socket.join(roomId);
        socket.emit('room-created', { roomId, players: rooms[roomId].players, hostId: socket.id });
    });

    // Join a room
    socket.on('join-room', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        
        if (!room) {
            socket.emit('error', { message: 'Oda bulunamadı! Kodu kontrol edin.' });
            return;
        }
        
        if (room.gameStarted) {
            socket.emit('error', { message: 'Oyun zaten başladı!' });
            return;
        }
        
        // Prevent duplicate names in room
        let name = playerName;
        if (room.players.find(p => p.name === name)) {
            name = `${name} (${Math.floor(Math.random() * 100)})`;
        }
        
        room.players.push({
            id: socket.id,
            name: name,
            currentPage: null,
            clicks: 0,
            isFinished: false,
            timeElapsed: null
        });
        
        socket.join(roomId);
        // Let user know they joined successfully
        socket.emit('room-joined', { roomId, players: room.players, hostId: room.hostId });
        // Update everyone else in the room
        socket.to(roomId).emit('room-updated', { players: room.players, hostId: room.hostId });
    });

    // Start Game (Only host)
    socket.on('start-game', ({ roomId, startPage, targetPage, gameMode }) => {
        const room = rooms[roomId];
        if (room && room.hostId === socket.id) {
            room.startPage = startPage;
            room.targetPage = targetPage;
            room.gameMode = gameMode || 'speed';
            room.gameStarted = true;
            room.startTime = Date.now();
            
            room.players.forEach(p => {
                p.currentPage = startPage;
                p.clicks = 0;
            });
            
            io.to(roomId).emit('game-started', { startPage, targetPage, gameMode: room.gameMode, players: room.players });
        }
    });

    // Update Progress
    socket.on('update-progress', ({ roomId, currentPage, clicks }) => {
        const room = rooms[roomId];
        if (room && room.gameStarted) {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                player.currentPage = currentPage;
                player.clicks = clicks;
                io.to(roomId).emit('progress-updated', { players: room.players });
            }
        }
    });

    // Finish Game
    socket.on('finish-game', ({ roomId, timeElapsed, pageHistory }) => {
        const room = rooms[roomId];
        if (room && room.gameStarted) {
            const player = room.players.find(p => p.id === socket.id);
            if (player && !player.isFinished) {
                player.isFinished = true;
                player.timeElapsed = timeElapsed;
                player.pageHistory = pageHistory || [];
                
                io.to(roomId).emit('game-finished', { winner: player, players: room.players });
            }
        }
    });

    // Send Emoji Reaction
    socket.on('send-emoji', ({ roomId, emoji }) => {
        const room = rooms[roomId];
        if (room) {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                socket.to(roomId).emit('emoji-received', { playerName: player.name, emoji });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // Handle player leaving
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                
                if (room.players.length === 0) {
                    delete rooms[roomId];
                } else {
                    // if host left, assign new host
                    if (room.hostId === socket.id) {
                        room.hostId = room.players[0].id;
                    }
                    io.to(roomId).emit('room-updated', { players: room.players, hostId: room.hostId });
                }
            }
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`WikiSprint Backend running on http://0.0.0.0:${PORT}`);
});

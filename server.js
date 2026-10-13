const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

const masterWordPool = [
    "قمر", "سيارة", "ساعة", "شجرة", "مفتاح", "بحر", "طائرة", "حاسوب",
    "هاتف", "قهوة", "كتاب", "نظارة", "جبل", "مطر", "قطة", "صحراء",
    "قلعة", "مصباح", "بوصلة", "جاسوس", "لوحة", "عاصفة", "بركان", "صقر",
    "تاج", "قناع", "صاروخ", "سفينة", "جزيرة", "مرآة", "صندوق", "خريطة",
    "الماس", "جسر", "برج", "نجم", "ذهب", "شلال", "كهف", "قنبلة",
    "دراجة", "محيط", "شاطئ", "قطار", "محرك", "زمرد", "سيف", "درع",
    "كوكب", "مجرة", "مجهر", "ليزر", "شاشة", "رادار", "غواصة", "مروحية",
    "زلزال", "مذنب", "منارة", "مختبر", "روبوت", "شبكة", "قمر صناعي", "سفينة فضائية"
];

function generateGrid() {
    const selectedWords = [...masterWordPool].sort(() => Math.random() - 0.5).slice(0, 40);
    let types = [
        ...Array(16).fill('blue'),
        ...Array(15).fill('red'),
        ...Array(8).fill('neutral'),
        'black'
    ].sort(() => Math.random() - 0.5);

    return selectedWords.map((word, index) => ({
        word: word,
        type: types[index],
        revealed: false,
        selectedBy: null
    }));
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomId, playerName, team, isLeader }) => {
        if (!roomId) return;

        if (!rooms[roomId]) {
            rooms[roomId] = {
                cards: generateGrid(),
                scoreBlue: 0,
                scoreRed: 0,
                currentTurn: 'blue',
                clue: 'في انتظار التلميح من القائد...',
                timer: 180,
                timerInterval: null,
                isTimerRunning: false,
                gameOver: false,
                players: {}
            };
        }

        const room = rooms[roomId];

        if (isLeader) {
            const existingLeader = Object.values(room.players).find(
                p => p.team === team && p.isLeader && p.id !== socket.id
            );
            if (existingLeader) {
                socket.emit('leaderSlotTaken', { 
                    message: `عذراً، مقعد القائد لـ ${team === 'blue' ? 'الفريق الأزرق' : 'الفريق الأحمر'} محجوز بالفعل!` 
                });
                return;
            }
        }

        socket.join(roomId);

        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            team: team,
            isLeader: isLeader
        };

        io.to(roomId).emit('updateGameState', { ...room, players: Object.values(room.players) });
    });

    // استقبال التلميح وبثه فوراً دون أي شروط معقدة تسبب التعطيل
    socket.on('submitClue', ({ roomId, word, count }) => {
        const room = rooms[roomId];
        if (!room) return;

        room.clue = `"${word}" (مطلوب: ${count})`;
        room.timer = 180;
        room.isTimerRunning = true;

        clearInterval(room.timerInterval);
        room.timerInterval = setInterval(() => {
            if (room.timer > 0 && room.isTimerRunning) {
                room.timer--;
                io.to(roomId).emit('timerUpdate', { timer: room.timer });
            } else if (room.timer === 0) {
                clearInterval(room.timerInterval);
                room.isTimerRunning = false;
                room.currentTurn = room.currentTurn === 'blue' ? 'red' : 'blue';
                room.clue = "في انتظار التلميح من القائد...";
                room.cards.forEach(c => c.selectedBy = null);
                io.to(roomId).emit('updateGameState', { ...room, players: Object.values(room.players) });
            }
        }, 1000);

        io.to(roomId).emit('updateGameState', { ...room, players: Object.values(room.players) });
    });

    socket.on('toggleSelectCard', ({ roomId, index }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[socket.id];
        if (!player || player.isLeader || room.cards[index].revealed) return;

        if (room.cards[index].selectedBy === player.name) {
            room.cards[index].selectedBy = null;
        } else {
            room.cards[index].selectedBy = player.name;
        }

        io.to(roomId).emit('updateGameState', { ...room, players: Object.values(room.players) });
    });

    socket.on('confirmSelection', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        const selectedIndices = room.cards
            .map((card, idx) => ({ card, idx }))
            .filter(item => item.card.selectedBy !== null && !item.card.revealed)
            .map(item => item.idx);

        if (selectedIndices.length === 0) return;

        let hitWrong = false;
        let hitBlack = false;

        selectedIndices.forEach(idx => {
            const card = room.cards[idx];
            card.revealed = true;
            card.selectedBy = null;

            if (card.type === room.currentTurn) {
                if (room.currentTurn === 'blue') room.scoreBlue++;
                if (room.currentTurn === 'red') room.scoreRed++;
            } else if (card.type === 'black') {
                hitBlack = true;
            } else {
                hitWrong = true;
            }
        });

        room.cards.forEach(c => c.selectedBy = null);

        if (room.scoreBlue >= 16) {
            room.gameOver = true;
            clearInterval(room.timerInterval);
            io.to(roomId).emit('gameWin', { winningTeam: 'blue' });
        } else if (room.scoreRed >= 15) {
            room.gameOver = true;
            clearInterval(room.timerInterval);
            io.to(roomId).emit('gameWin', { winningTeam: 'red' });
        } else if (hitBlack) {
            room.gameOver = true;
            clearInterval(room.timerInterval);
            io.to(roomId).emit('blackCardLoss', { losingTeam: room.currentTurn });
        } else if (hitWrong) {
            clearInterval(room.timerInterval);
            room.isTimerRunning = false;
            room.currentTurn = room.currentTurn === 'blue' ? 'red' : 'blue';
            room.clue = "في انتظار التلميح من القائد...";
        }

        io.to(roomId).emit('updateGameState', { ...room, players: Object.values(room.players) });
    });

    // إتاحة إنهاء الدور مباشرة للغرفة الحالية
    socket.on('endTurn', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        clearInterval(room.timerInterval);
        room.isTimerRunning = false;
        room.currentTurn = room.currentTurn === 'blue' ? 'red' : 'blue';
        room.clue = "في انتظار التلميح من القائد...";
        room.cards.forEach(c => c.selectedBy = null);
        
        io.to(roomId).emit('updateGameState', { ...room, players: Object.values(room.players) });
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            if (rooms[roomId].players[socket.id]) {
                delete rooms[roomId].players[socket.id];
                io.to(roomId).emit('updateGameState', {
                    ...rooms[roomId],
                    players: Object.values(rooms[roomId].players)
                });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`سيرفر شيفرة يعمل الآن على المنفذ ${PORT}`));

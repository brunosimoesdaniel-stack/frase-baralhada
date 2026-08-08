```javascript
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const rooms = new Map();

function createId() {
    return crypto.randomBytes(12).toString("hex");
}

function createRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;

    do {
        code = "";

        for (let i = 0; i < 5; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
    } while (rooms.has(code));

    return code;
}

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function broadcast(room, data) {
    for (const player of room.players.values()) {
        send(player.ws, data);
    }
}

function publicPlayers(room) {
    return [...room.players.values()].map(player => ({
        id: player.id,
        name: player.name,
        submitted: room.phrases.has(player.id)
    }));
}

function broadcastLobby(room) {
    broadcast(room, {
        type: "lobby",
        players: publicPlayers(room),
        state: room.state,
        hostId: room.hostId
    });
}


/*
 * Cria uma distribuição em que
 * ninguém recebe a própria frase.
 */
function createDistribution(players) {

    const ids = players.map(p => p.id);

    for (let attempt = 0; attempt < 10000; attempt++) {

        const shuffled = [...ids];

        for (let i = shuffled.length - 1; i > 0; i--) {

            const j =
                Math.floor(Math.random() * (i + 1));

            [shuffled[i], shuffled[j]] =
                [shuffled[j], shuffled[i]];
        }

        let valid = true;

        for (let i = 0; i < ids.length; i++) {

            if (ids[i] === shuffled[i]) {
                valid = false;
                break;
            }
        }

        if (valid) {
            return shuffled;
        }
    }

    /*
     * Fallback: rotação.
     */
    return ids.map(
        (_, index) =>
            ids[(index + 1) % ids.length]
    );
}


/*
 * HTTP SERVER
 */
const server = http.createServer((req, res) => {

    if (req.url === "/api/create-room") {

        const code = createRoomCode();
        const hostId = createId();

        rooms.set(code, {
            code,
            hostId,
            state: "lobby",
            players: new Map(),
            phrases: new Map()
        });

        res.writeHead(200, {
            "Content-Type": "application/json"
        });

        res.end(JSON.stringify({
            code,
            hostId
        }));

        return;
    }

    let requestedPath =
        req.url.split("?")[0];

    if (requestedPath === "/") {
        requestedPath = "/index.html";
    }

    const publicDir =
        path.join(__dirname, "public");

    const filePath =
        path.join(publicDir, requestedPath);

    if (!filePath.startsWith(publicDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    fs.readFile(filePath, (err, data) => {

        if (err) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }

        const ext =
            path.extname(filePath);

        const types = {
            ".html":
                "text/html; charset=utf-8",

            ".css":
                "text/css; charset=utf-8",

            ".js":
                "application/javascript; charset=utf-8"
        };

        res.writeHead(200, {
            "Content-Type":
                types[ext] ||
                "application/octet-stream"
        });

        res.end(data);
    });
});


/*
 * WEBSOCKET SERVER
 */
const wss =
    new WebSocket.Server({
        server
    });


wss.on("connection", (ws) => {

    let currentPlayer = null;
    let currentRoom = null;


    ws.on("message", raw => {

        let message;

        try {
            message =
                JSON.parse(
                    raw.toString()
                );
        } catch {
            return;
        }


        /*
         * ENTRAR NUMA SALA
         */
        if (message.type === "join") {

            const code =
                String(message.code || "")
                    .trim()
                    .toUpperCase();

            const name =
                String(message.name || "")
                    .trim()
                    .slice(0, 30);

            const hostId =
                String(message.hostId || "");

            if (!code || !name) {

                send(ws, {
                    type: "error",
                    message:
                        "Nome ou sala inválidos."
                });

                return;
            }

            const room =
                rooms.get(code);

            if (!room) {

                send(ws, {
                    type: "error",
                    message:
                        "Esta sala não existe."
                });

                return;
            }

            if (room.state !== "lobby") {

                send(ws, {
                    type: "error",
                    message:
                        "O jogo já começou."
                });

                return;
            }

            if (room.players.size >= 30) {

                send(ws, {
                    type: "error",
                    message:
                        "A sala está cheia."
                });

                return;
            }

            const duplicate =
                [...room.players.values()]
                    .some(
                        p =>
                            p.name.toLowerCase() ===
                            name.toLowerCase()
                    );

            if (duplicate) {

                send(ws, {
                    type: "error",
                    message:
                        "Esse nome já está a ser usado."
                });

                return;
            }

            const id =
                hostId === room.hostId
                    ? room.hostId
                    : createId();

            currentPlayer = id;
            currentRoom = room;

            room.players.set(id, {
                id,
                name,
                ws
            });

            send(ws, {
                type: "joined",
                id,
                room: room.code,
                isHost:
                    id === room.hostId
            });

            broadcastLobby(room);

            return;
        }


        /*
         * INICIAR JOGO
         */
        if (message.type === "start") {

            if (!currentRoom || !currentPlayer) {
                return;
            }

            const room = currentRoom;

            if (currentPlayer !== room.hostId) {
                return;
            }

            if (room.players.size < 2) {

                send(ws, {
                    type: "error",
                    message:
                        "São necessários pelo menos 2 jogadores."
                });

                return;
            }

            room.state = "writing";
            room.phrases.clear();

            broadcast(room, {
                type: "writing_started"
            });

            broadcastLobby(room);

            return;
        }


        /*
         * ENVIAR FRASE
         */
        if (message.type === "phrase") {

            if (!currentRoom || !currentPlayer) {
                return;
            }

            const room = currentRoom;

            if (room.state !== "writing") {
                return;
            }

            const phrase =
                String(message.phrase || "")
                    .trim()
                    .slice(0, 500);

            if (!phrase) {
                return;
            }

            if (!room.players.has(currentPlayer)) {
                return;
            }

            room.phrases.set(
                currentPlayer,
                phrase
            );

            send(ws, {
                type: "phrase_saved"
            });

            broadcastLobby(room);

            /*
             * Todos terminaram?
             */
            if (
                room.phrases.size ===
                room.players.size
            ) {

                room.state = "waiting";

                broadcast(room, {
                    type: "all_finished"
                });

                broadcastLobby(room);
            }

            return;
        }


        /*
         * BARALHAR
         */
        if (message.type === "shuffle") {

            if (!currentRoom || !currentPlayer) {
                return;
            }

            const room = currentRoom;

            if (currentPlayer !== room.hostId) {
                return;
            }

            if (room.state !== "waiting") {
                return;
            }

            const players =
                [...room.players.values()];

            if (
                room.phrases.size !==
                players.length
            ) {
                return;
            }

            const receivers =
                createDistribution(players);

            /*
             * Cada autor é associado
             * a outro jogador.
             */
            for (
                let i = 0;
                i < players.length;
                i++
            ) {

                const author =
                    players[i];

                const receiverId =
                    receivers[i];

                const receiver =
                    room.players.get(
                        receiverId
                    );

                const phrase =
                    room.phrases.get(
                        author.id
                    );

                if (receiver) {

                    send(receiver.ws, {
                        type: "result",
                        phrase
                    });
                }
            }

            room.state = "results";

            broadcast(room, {
                type: "results_started"
            });

            return;
        }


        /*
         * NOVA RONDA
         */
        if (message.type === "new_round") {

            if (!currentRoom || !currentPlayer) {
                return;
            }

            const room = currentRoom;

            if (currentPlayer !== room.hostId) {
                return;
            }

            room.state = "writing";
            room.phrases.clear();

            broadcast(room, {
                type: "writing_started"
            });

            broadcastLobby(room);

            return;
        }


        /*
         * APAGAR SALA
         */
        if (message.type === "delete_room") {

            if (!currentRoom || !currentPlayer) {
                return;
            }

            if (
                currentPlayer !==
                currentRoom.hostId
            ) {
                return;
            }

            const room = currentRoom;

            broadcast(room, {
                type: "room_deleted"
            });

            rooms.delete(room.code);

            return;
        }

    });


    /*
     * DESCONEXÃO
     */
    ws.on("close", () => {

        if (!currentRoom || !currentPlayer) {
            return;
        }

        const room = currentRoom;

        room.players.delete(
            currentPlayer
        );

        if (room.players.size === 0) {

            rooms.delete(
                room.code
            );

        } else {

            /*
             * Se o anfitrião sair,
             * outro jogador assume.
             */
            if (
                room.hostId ===
                currentPlayer
            ) {

                const newHost =
                    room.players
                        .values()
                        .next()
                        .value;

                room.hostId =
                    newHost.id;

                send(newHost.ws, {
                    type:
                        "became_host"
                });
            }

            /*
             * Se alguém sair durante
             * uma ronda, reiniciamos.
             */
            if (
                room.state !==
                "lobby"
            ) {

                room.state = "lobby";
                room.phrases.clear();

                broadcast(room, {
                    type: "game_reset",
                    message:
                        "Um jogador saiu. A ronda foi reiniciada."
                });
            }

            broadcastLobby(room);
        }
    });

});


server.listen(PORT, () => {

    console.log(
        `Frase Baralhada a correr na porta ${PORT}`
    );

});
```

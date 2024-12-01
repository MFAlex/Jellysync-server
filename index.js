import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';

const wss = new WebSocketServer({ port: 8080 });

const rooms = {}; //Record<string, SyncSession>
const connections = {}; //Record<string, {index: number, socket: WebSocket[], hasPinged: boolean}[]>, maps rooms to lists of connections
const memberPlayback = {}; //Record<string, {index: number, media: string, timestamp: number, state: ("playing" | "paused" | "buffering" | "nothing-playing")}>
const playbackState = {}; //Record<string, ("playing" | "paused" | "buffering" | "nothing-playing")>

wss.on('connection', function connection(ws) {
    let roomId;
    let memberIndex;
    const stageOneMessageHandler = (data) => {
        try {
            const json = JSON.parse(data.data);
            if (json.type !== "create" && json.type !== "join") {
                throw new Error("");
            }
            const roomDetails = json.type === "create" ? newRoom(json.displayName, json.jellyfinHost) : joinRoom(json.room, json.displayName);
            if (typeof roomDetails === "boolean") {
                throw new Error("");
            } else {
                enrolConnection(roomDetails);
            }
        } catch (err) {
            console.error(err);
            ws.close();
        }
    }
    const stageOneCloseHandler = () => {
        ws.removeEventListener('message', stageOneMessageHandler);
    }
    const stageTwoMessageHandler = (data) => {
        try {
            const dataObj = JSON.parse(data.data);
            const type = dataObj.type;
            if (typeof type !== "string") throw new Error("");
            handleIncomingMessage(roomId, memberIndex, type, dataObj);
        } catch (err) {
            console.error(err);
            ws.close();            
            if (roomId in connections) {
                connections[roomId] = connections[roomId].filter(it => it.index != memberIndex);
            }
            handleDisconnect(roomId, memberIndex, "Bad communication received");
        }
    }
    const stageTwoCloseHandler = () => {
        if (roomId in connections) {
            connections[roomId] = connections[roomId].filter(it => it.index != memberIndex);
        }
        if (roomId in rooms && rooms[roomId].members.findIndex(it => it.index == memberIndex) >= 0)
            handleDisconnect(roomId, memberIndex, "Disconnected");
        ws.removeEventListener('message', stageTwoMessageHandler);
    }
    const enrolConnection = (roomDetails) => { //{room: string room ID, index: number member ID}
        roomId = roomDetails.room;
        memberIndex = roomDetails.index;
        ws.removeEventListener('close', stageOneCloseHandler);
        ws.removeEventListener('message', stageOneMessageHandler);
        ws.addEventListener('close', stageTwoCloseHandler);
        ws.addEventListener('message', stageTwoMessageHandler);
        if (!(roomId in connections)) {
            connections[roomId] = [];
        }
        connections[roomId].push({index: memberIndex, socket: ws, hasPinged: true});
        handleJoin(roomId, memberIndex);
    }
    ws.addEventListener('close', stageOneCloseHandler);
    ws.addEventListener('message', stageOneMessageHandler);
});

function newRoom(displayName, jellyfinHost) { //returns {room: string room ID, index: number member ID} or false
    if (typeof displayName !== "string" || typeof jellyfinHost !== "string") return false;
    let uuid = uuidv4().replaceAll("-", "");
    let roomObject = {
        room: uuid,
        leader: 0,
        members: [{ index: 0, displayName }],
        jellyfinHost
    }
    rooms[uuid] = roomObject;
    playbackState[uuid] = "nothing-playing";
    memberPlayback[uuid] = [{
        index: 0,
        state: "nothing-playing"
    }];
    return { room: uuid, index: 0 };
}

function joinRoom(room, displayName) { //returns {room: string room ID, index: number member ID} or false
    if (typeof room !== "string" || typeof displayName !== "string") return false;
    if (room in rooms) {
        const roomObj = rooms[room];
        const memberId = Math.max(...roomObj.members.map(o => o.index)) + 1;
        const member = { displayName, index: memberId };
        roomObj.members.push(member);
        memberPlayback[room].push({
            index: memberId,
            state: "nothing-playing"
        });
        return { room, index: memberId };
    } else {
        return false;
    }
}

function handleIncomingMessage(roomId, memberIndex, type, data) {
    switch (type) {
        case "pong":
            connections[roomId].find(it => it.index == memberIndex).hasPinged = true;
            break;
        case "member-playback-state":
            const state = data.state;
            if (!(["playing", "paused", "buffering", "nothing-playing"].includes(state))) throw new Error("Illegal play state: '"+state+"'");
            if (state !== "nothing-playing" && (typeof data.timestamp !== "number" || typeof data.bufferSecs !== "number" || typeof data.media !== "string")) {
                throw new Error("Missing timestamp, bufferSecs or media when the play state isn't nothing-playing");
            }
            const update = {
                type: "member-playback-state",
                state,
                member: memberIndex
            }
            if (state !== "nothing-playing") {
                update["timestamp"] = data.timestamp;
                update["bufferSecs"] = data.bufferSecs;
            }
            broadcastToRoomExcept(roomId, memberIndex, update);

            //update our own state now
            if (!(roomId in memberPlayback)) memberPlayback[roomId] = [];
            const list = memberPlayback[roomId];
            const newState = {
                index: memberIndex,
                state
            }
            if (state !== "nothing-playing") {
                newState["timestamp"] = data.timestamp;
                newState["media"] = data.media;
            }
            const idx = list.findIndex(it => it.index == memberIndex);
            if (idx == -1) {
                list.push(newState);
            } else {
                list[idx] = newState;
            }
            handleMemberPlaybacks(roomId);
            break;
        case "change-playback-state":
            changePlaybackStateReceived(roomId, memberIndex, data);
            break;
        case "chat":
            if (typeof data.message !== "string") throw new Error("");
            const broadcast = {
                type: "chat",
                message: data.message,
                member: memberIndex
            };
            broadcastToRoomExcept(roomId, memberIndex, broadcast);

            //allow acknowledging which message got delivered
            broadcast["sequence"] = data.sequence;
            sendToMember(roomId, memberIndex, broadcast);
            break;
    }
}

function anyUsersBuffering(roomId) {
    const playbacks = memberPlayback[roomId];
    return playbacks.findIndex(it => it.state === "buffering") >= 0
}

function handleMemberPlaybacks(roomId) {
    const currentPlaybackState = playbackState[roomId];
    const anyBuffering = anyUsersBuffering(roomId);
    if (currentPlaybackState === "playing" && anyBuffering) {
        playbackState[roomId] = "buffering";
        syncToLeadersTime(roomId, true);
    } else if (currentPlaybackState === "buffering" && !anyBuffering) {
        playbackState[roomId] = "playing";
        syncToLeadersTime(roomId, true);
    }
}

function syncToLeadersTime(roomId, play) {
    const currentPlaybackState = playbackState[roomId];
    playbackState[roomId] = currentPlaybackState === "playing" ? "buffering" : currentPlaybackState;

    const leaderId = rooms[roomId].leader;
    const leaderState = memberPlayback[roomId].find(it => it.index == leaderId);
    const anyBuffering = anyUsersBuffering(roomId);

    if (leaderState.state !== "nothing-playing" && leaderState.timestamp != undefined && leaderState.media != undefined) {
        const broadcastMessage = {
            type: "playback-state",
            state: play ? (anyBuffering ? "buffering" : "playing") : "paused",
            timestamp: leaderState.timestamp,
            media: leaderState.media
        }
        broadcastToRoom(roomId, broadcastMessage);
        playbackState[roomId] = broadcastMessage.state;
    } else {
        const broadcastMessage = {
            type: "playback-state",
            state: "nothing-playing",
        }
        broadcastToRoom(roomId, broadcastMessage);
        playbackState[roomId] = "nothing-playing";
    }
}

function changePlaybackStateReceived(roomId, memberIndex, packet) {
    const room = rooms[roomId];
    const isLeader = room.leader == memberIndex;
    if (!(["playing", "paused", "nothing-playing"].includes(packet.state))) throw new Error();
    if (packet.state == "nothing-playing") {
        broadcastToRoom(roomId, {
            type: "playback-state",
            state: "nothing-playing",
        });
        broadcastToRoom(roomId, {
            type: "chat",
            member: "system",
            message: displayName + " ended playback"
        });
        playbackState[roomId] = "nothing-playing";
        memberPlayback[roomId].forEach(it => {
            it.state = "nothing-playing"
        });
        return;
    }
    if (typeof packet.timestamp !== "number") throw new Error();

    const broadcastMessage = {
        type: "playback-state",
        state: packet.state === "paused" ? "paused" : "buffering", //wait for everyone to signal they're not buffering through the member-play-state packet, even if the user wants to play
        timestamp: packet.timestamp
    }
    if (typeof packet.media === "string") {
        if (isLeader) {
            broadcastMessage["media"] = packet.media;
        } else {
            throw new Error("Only the leader can set media");
        }
    }
    broadcastToRoom(roomId, broadcastMessage);
    playbackState[roomId] = packet.state == "playing" ? "buffering" : "paused";
    memberPlayback[roomId].forEach(it => {
        //make sure we don't play until everyone is ready and consented
        it.state = "buffering"
    });

    const displayName = room.members.find(it => it.index == memberIndex).displayName;
    broadcastToRoom(roomId, {
        type: "chat",
        member: "system",
        message: displayName + " changed playback state to: " + packet.state
    });
}

function handleDisconnect(roomId, memberIndex, reason) {
    if (!(roomId in rooms)) return;
    const room = rooms[roomId];
    const displayName = room.members.find(it => it.index == memberIndex).displayName;
    //remove from room
    room.members = room.members.filter(it => it.index != memberIndex);
    //chat announcement
    broadcastToRoom(roomId, {
        type: "chat",
        member: "system",
        message: displayName + " left the room. Reason: " + reason
    });
    if (memberPlayback[roomId] != null) {
        memberPlayback[roomId] = memberPlayback[roomId].filter(it => it.index != memberIndex);
    }
    if (room.members.length > 0) {
        //announce new members
        broadcastToRoom(roomId, {
            type: "member-change",
            members: room.members
        });
        //if playing: pause
        syncToLeadersTime(roomId, false);
        //if that was the leader, promote someone else
        const hasLeader = room.members.findIndex(it => it.index == room.leader) >= 0;
        if (!hasLeader) {
            room.leader = room.members[0].index;
            const newName = room.members[0].displayName;
            broadcastToRoom(roomId, {
                type: "chat",
                member: "system",
                message: newName + " was promoted to leader"
            });
            broadcastToRoom(roomId, {
                type: "leader-change",
                newLeader: room.leader
            });
        }
    } else {
        //if last member, delete room
        delete connections[roomId];
        delete rooms[roomId];
        delete playbackState[roomId];
        delete memberPlayback[roomId];
    }
}

/*
 * Assume the connection is already in the connections object
 */
function handleJoin(roomId, memberIndex) {
    //assume user already added to rooms object
    const room = rooms[roomId];
    //notify joiner of the session
    sendToMember(roomId, memberIndex, {
        type: "session",
        room: roomId,
        leader: room.leader,
        you: memberIndex,
        members: room.members,
        jellyfinHost: room.jellyfinHost
    });
    //broadcast new members
    broadcastToRoomExcept(roomId, memberIndex, {
        type: "member-change",
        members: room.members
    });
    //chat announcement
    const displayName = room.members.find(it => it.index == memberIndex).displayName;
    broadcastToRoom(roomId, {
        type: "chat",
        member: "system",
        message: displayName + " joined the room."
    });
    //sync everyone
    syncToLeadersTime(roomId, false);
}

function broadcastToRoom(roomId, data) {
    const connectionList = connections[roomId];
    for (let item of connectionList) {
        item.socket.send(JSON.stringify(data));
    }
}

function broadcastToRoomExcept(roomId, memberId, data) {
    const connectionList = connections[roomId];
    for (let item of connectionList) {
        if (item.index != memberId) {
            item.socket.send(JSON.stringify(data));
        }
    }
}

function sendToMember(roomId, memberId, data) {
    const connectionList = connections[roomId];
    for (let item of connectionList) {
        if (item.index == memberId) {
            item.socket.send(JSON.stringify(data));
            return;
        }
    }
}

function doPing() {
    for (let room of Object.keys(connections)) {
        for (let connection of connections[room]) {
            if (connection.hasPinged == false) {
                connection.socket.close();
                connections[room] = connections[room].filter(it => it.index != connection.index);
                handleDisconnect(room, connection.index, "Timed out");
            } else {
                connection.hasPinged = false;
                sendToMember(room, connection.index, { type: "ping" })
            }
        }
    }   
}
setInterval(doPing, 10000);
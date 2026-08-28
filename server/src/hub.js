// 全局单例：房间管理器（REST 与 Socket 共享同一实例）
const RoomManager = require('./rooms');

module.exports = new RoomManager();

// Ploq server: the Worker's entry point. See core.js for the HTTP API and room.js for the
// live rooms.

import { createApp } from "./core.js";

export { Room } from "./room.js";
export default createApp();

/** Run the HTTP API. */
import { start } from '../src/api/server.js';

start().catch((err) => {
  console.error(err);
  process.exit(1);
});

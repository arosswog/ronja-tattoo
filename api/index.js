const { createApp } = require("../server");

// Vercel serverless entrypoint: reuse the same Express app as the
// standalone server and let it handle every incoming request.
module.exports = createApp();

const { createApp } = require("../server");

// Vercel serverless entrypoint: reuse the same Express app as the standalone
// server. The app is created lazily on the first request (instead of at module
// import time) and every invocation is guarded, so an unexpected error can
// never escape to the Lambda runtime and surface as the opaque
// "This Serverless Function has crashed" / FUNCTION_INVOCATION_FAILED page.
// Instead the real error is logged (visible in the Vercel logs) and the client
// receives a normal JSON 500 response.
let app;

function getApp() {
  if (!app) {
    app = createApp();
  }

  return app;
}

module.exports = (req, res) => {
  try {
    return getApp()(req, res);
  } catch (error) {
    console.error("Ronja Tattoo serverless handler failed:", error);

    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: "Es ist ein unerwarteter Serverfehler aufgetreten.",
        })
      );
    } else {
      res.end();
    }
  }
};

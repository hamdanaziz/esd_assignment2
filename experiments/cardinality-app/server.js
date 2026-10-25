// server.js (cardinality demo)
//
// Part E.2 - Cardinality explosion.
//
// This is a deliberately isolated "local test counter", separate from the
// real QuickBite app, so the experiment can't pollute real dashboards.
//
// Run with LABELED=true  -> demo_requests_total{request_id="..."} - one
//                            new time series per unique request_id.
// Run with LABELED=false -> demo_requests_total (no label) - a single
//                            series no matter how many hits it takes.
//
// See experiments/cardinality_test.sh for the driver script that exercises
// this in both modes and reads back the series count from Prometheus.

const http = require('http');
const client = require('prom-client');

const LABELED = process.env.LABELED === 'true';
const PORT = process.env.PORT || 9091;

const register = new client.Registry();

const counter = new client.Counter({
  name: 'demo_requests_total',
  help: 'Demo counter used to illustrate cardinality explosion when labeled by request_id',
  labelNames: LABELED ? ['request_id'] : [],
  registers: [register],
});

let hits = 0;

const server = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
    return;
  }

  if (req.url.startsWith('/hit')) {
    hits += 1;
    if (LABELED) {
      // Every call gets its own unique label value, exactly like using a
      // request id as a Prometheus label in production code.
      counter.inc({ request_id: `req_${hits}` });
    } else {
      counter.inc();
    }
    res.end(`hit ${hits} (labeled=${LABELED})\n`);
    return;
  }

  res.writeHead(404);
  res.end('not found\n');
});

server.listen(PORT, () => {
  console.log(`cardinality-demo listening on :${PORT} (LABELED=${LABELED})`);
});

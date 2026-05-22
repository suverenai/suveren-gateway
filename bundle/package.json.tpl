{
  "name": "@suveren/gateway",
  "version": "__VERSION__",
  "description": "Suveren gateway — local agent gateway built in compliance with the Human Agency Protocol (HAP). Runs the UI, control plane, and MCP server in one Node process.",
  "type": "module",
  "main": "server.js",
  "bin": {
    "suveren-gateway": "bin/suveren-gateway.js"
  },
  "scripts": {
    "postinstall": "node scripts/postinstall.js"
  },
  "files": [
    "bin",
    "dist",
    "scripts",
    "content",
    "profiles",
    "server.js",
    "README.md"
  ],
  "engines": {
    "node": ">=20"
  },
  "dependencies": {},
  "repository": {
    "type": "git",
    "url": "git+https://github.com/suverenai/suveren-gateway.git"
  },
  "homepage": "https://www.suveren.ai",
  "license": "MIT",
  "keywords": [
    "suveren",
    "hap",
    "human-agency-protocol",
    "ai-agent",
    "mcp",
    "gateway",
    "authorization"
  ]
}

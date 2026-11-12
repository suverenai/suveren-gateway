# Give the AI its own place

An AI with a terminal can run any program. On the computer where the gateway
runs, under the same user account, it could reach what the gateway holds. So
it gets its own place: a container with **one door**.

Through the door the AI reaches two things:

- the Suveren gateway on this computer,
- its AI provider.

It reaches nothing else: no other website, no other program on the computer,
none of your files except the one folder you give it.

This is a setup aid, not a guarantee. It was tested as described under
[What was tested](#what-was-tested); read [What it does not cover](#what-it-does-not-cover)
before you rely on it.

## What you need

- Docker (Docker Desktop on macOS).
- A running Suveren gateway on this computer. These steps use its default MCP
  port, `3430`. If yours differs (`suveren-gateway config get mcp-port`), use
  that number wherever `3430` appears.
- The two files in [`docs/sandbox/`](sandbox/): `Dockerfile` (the AI's place)
  and `door.js` (the door).
- A key for your AI provider. Signing in through a browser is not covered.

## Steps

Run them from the folder that holds the two files.

**1. Build the AI's place.** Once; this step needs the internet.

```sh
docker build -t ai-place .
```

**2. Create the sealed network.** `--internal` means: no way out.

```sh
docker network create --internal --subnet 172.30.0.0/24 ai-sealed
```

**3. Start the door.** It stands with one foot in the normal network and one in
the sealed one. `ALLOW` lists the hosts the AI may reach; here, Anthropic.

```sh
docker run -d --name ai-door \
  -e ALLOW=api.anthropic.com \
  -e GATEWAY_PORT=3430 \
  -v "$PWD/door.js:/door.js:ro" \
  node:22-alpine node /door.js

docker network connect --ip 172.30.0.2 ai-sealed ai-door
```

**4. Start the AI's place.** It is attached to the sealed network only. The
folder after `-v` is the one folder of yours the AI can see; give it a project
folder, never your home folder.

```sh
docker run --rm -it --name ai \
  --network ai-sealed \
  -e HTTPS_PROXY=http://172.30.0.2:3128 \
  -e NO_PROXY=172.30.0.2 \
  -e ANTHROPIC_API_KEY \
  -v "$PWD/work:/work" \
  ai-place bash
```

`-e ANTHROPIC_API_KEY` passes the key from your own shell into the AI's place
without writing it into a file or the command line.

**5. Inside, connect the AI app to the gateway** and start it.

```sh
claude mcp add --transport http suveren-gateway http://172.30.0.2:3430/mcp
claude mcp list        # must show: suveren-gateway … ✔ Connected
claude
```

The address is a number on purpose. A gateway without a token answers only to
`localhost` or a numeric address, so a name such as `ai-door` is refused.

## Check it yourself

Still inside the AI's place, all three must fail:

```sh
curl -m 6 https://example.com/            # another website
curl -m 6 http://1.1.1.1/                 # the internet by number
curl -m 6 -x http://172.30.0.2:3128 https://example.com/   # through the door
```

And on your computer, the door's log shows what it refused:

```sh
docker logs ai-door
```

## Another AI provider

Put its host into `ALLOW`, comma-separated, and install its app in the
`Dockerfile` instead of, or next to, Claude Code:

```sh
-e ALLOW=api.anthropic.com,api.openai.com
```

Only port 443 of the listed hosts passes. An AI app may try to reach other
hosts, for example to send usage logs. The door refuses those; in the test
Claude Code kept working.

## Stop and remove

```sh
docker rm -f ai-door
docker network rm ai-sealed
```

## What was tested

On 2026-11-12, on macOS with Docker Desktop, with Claude Code 2.1.322 inside
and a gateway from source:

- Claude Code connected to the gateway through the door (`✔ Connected`), and an
  MCP session could be opened.
- A request to `api.anthropic.com` arrived (it answered "invalid API key" to a
  made-up key).
- Refused: another website by name, the internet by number, plain HTTP, an
  allowed host on another port, another program on the same computer, and
  every address when the door is bypassed.
- Inside, the computer's `/Users` folder does not exist, and no key of the
  computer is in the environment.

## What it does not cover

- **Signing in to an AI app through the browser.** That needs more hosts than
  the one in `ALLOW`. The test used a key.
- **A working session with a real key.** The test proved the path with a
  made-up key, not the work.
- **Other AI apps.** Only Claude Code was run inside. Another app should work
  the same way with its provider's host, but that was not run.
- **Windows and Linux.** On Linux, `host.docker.internal` does not reach a
  gateway that listens on `127.0.0.1`; the door needs another way to the
  gateway there. Not tested on either.
- **The folder you give it.** The AI sees everything in `/work`. A password in
  that folder is within its reach.
- **What the AI does through the gateway.** The door limits where the AI can
  go. What it may do in your systems is still decided by the mandates.
- **A fault in Docker itself.** A container is a strong wall, not a perfect
  one. A separate computer or virtual machine is stronger.

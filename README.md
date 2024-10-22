This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## AWPS Tunnel

Use `awps-tunnel` to transfer data from Azure Web PubSub to local server.

```bash
awps-tunnel run --hub chat --upstream http://localhost:8000
```

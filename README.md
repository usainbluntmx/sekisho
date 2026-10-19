# template-evm

A personal, production-ready template for building EVM-compatible decentralized applications (dApps) and protocols. Designed to be cloned, configured, and deployed quickly for hackathons, competitions, or personal projects.

Supports **Arbitrum**, **Base**, and **Monad** out of the box, with easy extensibility to any EVM-compatible chain.

---

## Table of Contents

- [What Is This?](#what-is-this)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Backend Guide](#backend-guide)
- [Frontend Guide](#frontend-guide)
- [Environment Variables](#environment-variables)
- [Available Scripts](#available-scripts)
- [Deploying a Smart Contract](#deploying-a-smart-contract)
- [Verifying a Smart Contract](#verifying-a-smart-contract)
- [Running Tests](#running-tests)
- [Deploying the Frontend to Vercel](#deploying-the-frontend-to-vercel)
- [Using This Template for a New Project](#using-this-template-for-a-new-project)
- [Supported Networks](#supported-networks)
- [Glossary](#glossary)

---

## What Is This?

`template-evm` is a full-stack monorepo template built to accelerate the development of Ethereum-compatible dApps. It comes pre-configured with everything you need:

- A **Hardhat** environment for writing, compiling, testing, and deploying Solidity smart contracts.
- A **Next.js** frontend with wallet connection powered by Reown AppKit and Wagmi.
- Multi-chain support with a centralized network configuration.
- Automated deploy and verification scripts.
- Code quality tools (ESLint, Prettier, solhint) already configured.

The goal is simple: clone this repo, replace the example contract and frontend with your own, fill in your environment variables, and you are ready to ship.

---

## Tech Stack

### Backend

| Tool | Purpose |
|---|---|
| [Hardhat v2](https://hardhat.org/) | Ethereum development environment |
| [Solidity ^0.8.36](https://soliditylang.org/) | Smart contract language |
| [OpenZeppelin Contracts](https://www.openzeppelin.com/contracts) | Secure, audited contract libraries |
| [hardhat-deploy](https://github.com/wighawag/hardhat-deploy) | Deterministic deployment system |
| [hardhat-toolbox](https://hardhat.org/hardhat-runner/plugins/nomicfoundation-hardhat-toolbox) | Bundled Hardhat plugins |
| [hardhat-network-helpers](https://hardhat.org/hardhat-network/docs/helpers) | Test utilities (time manipulation, snapshots) |
| [hardhat-gas-reporter](https://github.com/cgewecke/hardhat-gas-reporter) | Gas usage reports during tests |
| [solidity-coverage](https://github.com/sc-forks/solidity-coverage) | Code coverage for Solidity |
| [TypeChain](https://github.com/dethcrypto/TypeChain) | TypeScript bindings for contracts |
| [Mocha](https://mochajs.org/) + [Chai](https://www.chaijs.com/) | Testing framework and assertions |
| [solhint](https://protofire.github.io/solhint/) | Solidity linter |
| [Prettier](https://prettier.io/) + [prettier-plugin-solidity](https://github.com/prettier-solidity/prettier-plugin-solidity) | Code formatter |
| [dotenv](https://github.com/motdotla/dotenv) | Environment variable management |
| [ethers v6](https://docs.ethers.org/v6/) | Ethereum library |

### Frontend

| Tool | Purpose |
|---|---|
| [Next.js 16](https://nextjs.org/) | React framework with SSR and Vercel-native deployment |
| [React 19](https://react.dev/) | UI library |
| [TypeScript](https://www.typescriptlang.org/) | Typed JavaScript |
| [Wagmi](https://wagmi.sh/) | React hooks for Ethereum |
| [Viem](https://viem.sh/) | TypeScript Ethereum client |
| [Reown AppKit](https://reown.com/appkit) | Wallet connection modal and session management |
| [@x402](https://x402.org) + [@solana/kit](https://github.com/solana-labs/kit) | Runtime deps of AppKit's Base Smart Wallet connector (cdp-sdk) — required for `next build` |
| [TanStack Query](https://tanstack.com/query) | Async state management |
| [Tailwind CSS v4](https://tailwindcss.com/) | Utility-first CSS framework |
| [shadcn/ui](https://ui.shadcn.com/) | Accessible, composable UI components |
| [ESLint](https://eslint.org/) | JavaScript/TypeScript linter |
| [Prettier](https://prettier.io/) | Code formatter |

---

## Project Structure

```
template-evm/
├── .gitignore                  # Global Git ignore rules
├── backend/
│   ├── contracts/
│   │   └── Counter.sol         # Example contract (replace with yours)
│   ├── deploy/
│   │   └── 01_deploy_counter.ts  # Deploy script (one file per contract)
│   ├── scripts/
│   │   └── deploy-and-verify.ts  # Automated deploy + verify in one command
│   ├── test/
│   │   └── Counter.test.ts     # Contract tests
│   ├── typechain-types/        # Auto-generated TypeScript typings (do not edit)
│   ├── .env                    # Your private environment variables (never commit)
│   ├── .prettierrc             # Prettier config for Solidity
│   ├── .solhint.json           # Solidity linting rules
│   ├── hardhat.config.ts       # Hardhat + network + plugin configuration
│   ├── package.json
│   └── tsconfig.json
└── frontend/
    ├── app/
    │   ├── globals.css         # Global styles
    │   ├── layout.tsx          # Root layout with AppKitProvider
    │   └── page.tsx            # Home page
    ├── components/ui/          # shadcn/ui components (add via CLI)
    ├── config/
    │   ├── appkit.ts           # Reown AppKit + Wagmi adapter config
    │   └── chains.ts           # Centralized network definitions
    ├── context/
    │   └── AppKitProvider.tsx  # Global wallet provider
    ├── hooks/                  # Custom React hooks (add yours here)
    ├── lib/
    │   └── utils.ts            # shadcn/ui utility functions
    ├── public/                 # Static assets
    ├── .env.local              # Your private environment variables (never commit)
    ├── .prettierrc             # Prettier config for TypeScript/React
    ├── components.json         # shadcn/ui configuration
    ├── eslint.config.mjs       # ESLint configuration
    ├── next.config.ts          # Next.js configuration
    ├── package.json
    └── tsconfig.json
```

---

## Prerequisites

Before using this template, make sure you have the following installed on your machine:

| Requirement | Minimum Version | Check |
|---|---|---|
| [Node.js](https://nodejs.org/) | v24 LTS or higher | `node --version` |
| [npm](https://www.npmjs.com/) | v11 or higher | `npm --version` |
| [Git](https://git-scm.com/) | Any recent version | `git --version` |

You will also need:

- A crypto wallet (e.g., [MetaMask](https://metamask.io/)) to interact with the dApp.
- A **Reown Project ID** (free) from [cloud.reown.com](https://cloud.reown.com) for wallet connection.
- RPC URLs for the networks you want to deploy to (e.g., from [Alchemy](https://www.alchemy.com/) or [Infura](https://infura.io/)).
- Explorer API keys for contract verification (e.g., [Arbiscan](https://arbiscan.io/), [Basescan](https://basescan.org/)).

---

## Getting Started

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd template-evm
```

### 2. Install backend dependencies

```bash
cd backend
npm install
```

### 3. Install frontend dependencies

```bash
cd ../frontend
npm install
```

### 4. Configure environment variables

See the [Environment Variables](#environment-variables) section below.

---

## Backend Guide

The backend is a Hardhat project located in the `backend/` folder.

### Compile contracts

```bash
cd backend
npm run compile
```

This compiles all `.sol` files in `contracts/` and auto-generates TypeScript typings in `typechain-types/`.

### Run tests

```bash
npm run test
```

### Check code coverage

```bash
npm run coverage
```

### Start a local blockchain node

```bash
npm run node
```

This starts a local Hardhat node at `http://127.0.0.1:8545` with pre-funded test accounts. Keep this terminal open while developing locally.

### Clean build artifacts

```bash
npm run clean
```

---

## Frontend Guide

The frontend is a Next.js project located in the `frontend/` folder.

### Start development server

```bash
cd frontend
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build for production

```bash
npm run build
```

### Start production server locally

```bash
npm run start
```

### Add a shadcn/ui component

```bash
npx shadcn@latest add button
```

Replace `button` with any component from the [shadcn/ui catalog](https://ui.shadcn.com/docs/components).

---

## Environment Variables

### Backend — `backend/.env`

```bash
# Your wallet private key (without 0x prefix)
PRIVATE_KEY=

# RPC URLs — get these from Alchemy, Infura, or your provider
ARBITRUM_RPC_URL=
ARBITRUM_SEPOLIA_RPC_URL=
BASE_RPC_URL=
BASE_SEPOLIA_RPC_URL=
MONAD_TESTNET_RPC_URL=

# Explorer API keys for contract verification
ARBISCAN_API_KEY=
BASESCAN_API_KEY=

# Set to "true" to enable gas reporting during tests
REPORT_GAS=false
```

> ⚠️ Never commit your `.env` file. It is already protected by `.gitignore`.

### Frontend — `frontend/.env.local`

```bash
# Get your Project ID at https://cloud.reown.com
NEXT_PUBLIC_REOWN_PROJECT_ID=
```

> ⚠️ Never commit your `.env.local` file. It is already protected by `.gitignore`.

---

## Available Scripts

### Backend (`cd backend`)

| Command | Description |
|---|---|
| `npm run compile` | Compile all Solidity contracts |
| `npm run test` | Run all tests |
| `npm run coverage` | Run tests with coverage report |
| `npm run node` | Start local Hardhat node |
| `npm run clean` | Remove build artifacts |
| `npm run deploy:local` | Deploy to local Hardhat node |
| `npm run deploy:arbitrum` | Deploy to Arbitrum Mainnet |
| `npm run deploy:arbitrumSepolia` | Deploy to Arbitrum Sepolia testnet |
| `npm run deploy:base` | Deploy to Base Mainnet |
| `npm run deploy:baseSepolia` | Deploy to Base Sepolia testnet |
| `npm run deploy:monadTestnet` | Deploy to Monad Testnet |
| `npm run verify:arbitrum` | Verify contract on Arbitrum Mainnet |
| `npm run verify:arbitrumSepolia` | Verify contract on Arbitrum Sepolia |
| `npm run verify:base` | Verify contract on Base Mainnet |
| `npm run verify:baseSepolia` | Verify contract on Base Sepolia |

### Frontend (`cd frontend`)

| Command | Description |
|---|---|
| `npm run dev` | Start development server at localhost:3000 |
| `npm run build` | Build for production |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |

---

## Deploying a Smart Contract

### To a local node

Open two terminals:

**Terminal 1 — start the node:**
```bash
cd backend
npm run node
```

**Terminal 2 — deploy:**
```bash
cd backend
npm run deploy:local
```

### To a testnet or mainnet

Make sure your `backend/.env` has the correct `PRIVATE_KEY` and RPC URL for your target network, then run:

```bash
npm run deploy:arbitrumSepolia
```

Replace `arbitrumSepolia` with your target network. The deploy script will automatically wait for enough confirmations before proceeding.

### Automated deploy + verify in one command

```bash
npx hardhat run scripts/deploy-and-verify.ts --network arbitrumSepolia
```

This script deploys the contract, waits 30 seconds for the explorer to index it, and then verifies it automatically.

---

## Verifying a Smart Contract

Contract verification makes your source code publicly readable on block explorers (Arbiscan, Basescan, etc.).

### Verify after deploy

```bash
npm run verify:arbitrumSepolia
```

You can also verify manually with a specific address:

```bash
npx hardhat verify --network arbitrumSepolia <CONTRACT_ADDRESS>
```

If your constructor takes arguments:

```bash
npx hardhat verify --network arbitrumSepolia <CONTRACT_ADDRESS> <ARG1> <ARG2>
```

> Make sure your explorer API key is set in `backend/.env` before verifying.

---

## Running Tests

```bash
cd backend
npm run test
```

To run a specific test file:

```bash
npx hardhat test test/Counter.test.ts
```

To run with gas reporting enabled:

```bash
REPORT_GAS=true npm run test
```

To run with coverage:

```bash
npm run coverage
```

Coverage results will appear in `backend/coverage/index.html`. Open it in a browser for a detailed line-by-line report.

---

## Deploying the Frontend to Vercel

1. Push your repository to GitHub.
2. Go to [vercel.com](https://vercel.com) and click **Add New Project**.
3. Import your GitHub repository.
4. Set the **Root Directory** to `frontend`.
5. Add your environment variable: `NEXT_PUBLIC_REOWN_PROJECT_ID`.
6. Click **Deploy**.

Vercel will automatically redeploy every time you push to your main branch.

---

## Using This Template for a New Project

1. Clone the repo and set up environment variables as described above.
2. Replace `backend/contracts/Counter.sol` with your own contract.
3. Update `backend/deploy/01_deploy_counter.ts` with your contract name and constructor arguments.
4. Update `backend/test/Counter.test.ts` with tests for your contract.
5. Compile and test: `npm run compile && npm run test`.
6. Update `frontend/app/page.tsx` with your dApp UI.
7. Update `frontend/config/appkit.ts` with your app name, description, and URL.
8. Deploy your contract to the target network.
9. Connect your frontend to the deployed contract using the generated TypeChain types from `backend/typechain-types/`.
10. Deploy the frontend to Vercel.

---

## Supported Networks

| Network | Type | Chain ID |
|---|---|---|
| Hardhat (local) | Local | 31337 |
| Localhost | Local | 31337 |
| Arbitrum One | Mainnet | 42161 |
| Arbitrum Sepolia | Testnet | 421614 |
| Base | Mainnet | 8453 |
| Base Sepolia | Testnet | 84532 |
| Monad Testnet | Testnet | 10143 |

### Adding a new network

**Backend — `backend/hardhat.config.ts`:**

```typescript
newNetwork: {
  chainId: 12345,
  url: process.env.NEW_NETWORK_RPC_URL || "",
  accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
},
```

**Frontend — `frontend/config/chains.ts`:**

```typescript
export const newNetwork = {
  id: 12345,
  name: "New Network",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.newnetwork.xyz"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.newnetwork.xyz" } },
} as const satisfies AppKitNetwork;
```

Then add it to the `networks` array in the same file.

---

## Glossary

**dApp** — Decentralized application. An app whose backend logic runs on a blockchain via smart contracts.

**EVM** — Ethereum Virtual Machine. The runtime environment for smart contracts on Ethereum and compatible chains (Arbitrum, Base, Monad, etc.).

**Smart Contract** — A self-executing program deployed on a blockchain. Once deployed, its code cannot be changed.

**ABI** — Application Binary Interface. Describes the functions and events of a smart contract so frontends can interact with it.

**RPC URL** — Remote Procedure Call URL. The endpoint your app uses to communicate with a blockchain node.

**Testnet** — A public blockchain network used for testing. Tokens have no real value. Use testnets before deploying to mainnet.

**Mainnet** — The live, production blockchain where real assets are at stake.

**Gas** — The fee paid to execute transactions and smart contract functions on an EVM chain.

**Wallet** — Software (e.g., MetaMask) that manages your private keys and lets you sign transactions.

**Private Key** — A secret cryptographic key that proves ownership of a wallet. Never share it or commit it to Git.

**Contract Verification** — The process of uploading your contract source code to a block explorer so anyone can read and audit it.

**TypeChain** — A tool that generates TypeScript type definitions from your compiled contracts, enabling type-safe contract interactions.

**hardhat-deploy** — A Hardhat plugin that manages deterministic deployments and keeps track of deployed contract addresses across networks.

**Reown AppKit** — A wallet connection library (formerly WalletConnect AppKit) that provides a customizable modal for connecting Web3 wallets.

**Wagmi** — A collection of React hooks for interacting with Ethereum, built on top of Viem.

**Viem** — A lightweight, type-safe TypeScript library for Ethereum interactions.

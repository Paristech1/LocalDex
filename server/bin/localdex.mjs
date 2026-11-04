#!/usr/bin/env node
// LocalDex headless CLI: `localdex run "<task>" [options]` (see `localdex --help`).
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli.ts');
process.exitCode = await main(process.argv.slice(2));
// Language servers, MCP or council processes must not keep the process alive after the answer is printed.
setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();

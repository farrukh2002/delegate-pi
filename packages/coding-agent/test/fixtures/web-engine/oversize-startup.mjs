#!/usr/bin/env node
import { keepAlive } from "./harness.mjs";

process.stdout.write(`${"x".repeat(70_000)}\n`);
keepAlive();

#!/usr/bin/env node
import { keepAlive } from "./harness.mjs";

process.stdout.write('{"type":"ready","protocolVersion":1}\n');
keepAlive();

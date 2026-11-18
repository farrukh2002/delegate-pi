#!/usr/bin/env node
import { keepAlive } from "./harness.mjs";

process.stdout.write("not a frame\n");
keepAlive();

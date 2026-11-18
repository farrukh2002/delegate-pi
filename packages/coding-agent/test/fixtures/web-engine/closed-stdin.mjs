#!/usr/bin/env node
import { closeSync } from "node:fs";
import { keepAlive, ready } from "./harness.mjs";

closeSync(0);
ready();
keepAlive();

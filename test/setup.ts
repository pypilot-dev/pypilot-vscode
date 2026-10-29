/**
 * bun test preload: "vscode" only exists inside the extension host, so unit
 * tests get an empty stub. Tests only import modules whose tested functions
 * never touch it (the report HTML builder, for example).
 */
import { mock } from "bun:test";

mock.module("vscode", () => ({}));

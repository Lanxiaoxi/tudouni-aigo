#!/usr/bin/env python3
"""A minimal MCP server over stdio, for exercising the client without a network.

It speaks exactly the subset the client uses: initialize, the initialized
notification, tools/list, tools/call. One tool, `echo`, which returns its argument
— enough to prove the whole path works and that the arguments arrive intact.

Not part of the product: it exists so the MCP client can be tested end to end
without depending on an npm package being installed.
"""

import json
import sys

PROTOCOL_VERSION = "2024-11-05"

TOOLS = [
    {
        "name": "echo",
        "description": "把传进来的 text 原样返回。用来验证 MCP 通路。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "要原样返回的文本"},
            },
            "required": ["text"],
            "additionalProperties": False,
        },
    },
    {
        "name": "count.lines",
        "description": "数一数 text 有几行。名字里带点，用来验证名字净化。",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "要数的文本"}},
            "required": ["text"],
            "additionalProperties": False,
        },
    },
]


def reply(message_id, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": message_id, "result": result}) + "\n")
    sys.stdout.flush()


def error(message_id, code, text):
    sys.stdout.write(json.dumps(
        {"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": text}}) + "\n")
    sys.stdout.flush()


def handle(message):
    method = message.get("method")
    params = message.get("params") or {}
    message_id = message.get("id")

    if method == "initialize":
        reply(message_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "fake-mcp", "version": "0.1"},
        })
        return

    if method == "notifications/initialized":
        return  # a notification: no answer is expected

    if method == "tools/list":
        reply(message_id, {"tools": TOOLS})
        return

    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments") or {}
        text = str(arguments.get("text", ""))
        if name == "echo":
            reply(message_id, {"content": [{"type": "text", "text": "echo: " + text}]})
            return
        if name == "count.lines":
            lines = 0 if text == "" else len(text.split("\n"))
            reply(message_id, {"content": [{"type": "text", "text": f"{lines} 行"}]})
            return
        error(message_id, -32602, f"unknown tool: {name}")
        return

    if message_id is not None:
        error(message_id, -32601, f"unknown method: {method}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            # A client that sends something unparseable gets a line on stderr, not
            # silence: the whole point of this program is to be diagnosable.
            sys.stderr.write("not json: %r\n" % line[:120])
            continue
        handle(message)


if __name__ == "__main__":
    main()

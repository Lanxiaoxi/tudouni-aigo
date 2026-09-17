"""A mock OpenAI-compatible gateway, for the end-to-end check.

It is a script, not a simulation: the first request is answered with a tool call,
the second with text. That is enough to prove the whole path — request, tool,
permission, result, second request, answer, session file — without a network
dependency or a real key.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

STEP = {"n": 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        stream = bool(body.get("stream"))

        STEP["n"] += 1
        if STEP["n"] == 1:
            payload = {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {
                                        "name": "read_file",
                                        "arguments": json.dumps({"path": "hello.txt"}),
                                    },
                                }
                            ],
                        }
                    }
                ],
                "usage": {"prompt_tokens": 120, "completion_tokens": 8,
                          "prompt_tokens_details": {"cached_tokens": 100}},
            }
        else:
            payload = {
                "choices": [
                    {"message": {"role": "assistant", "content": "read it, all good"}}
                ],
                "usage": {"prompt_tokens": 200, "completion_tokens": 12,
                          "prompt_tokens_details": {"cached_tokens": 0}},
            }

        if not stream:
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        message = payload["choices"][0]["message"]
        if message.get("content"):
            chunk = {"choices": [{"delta": {"content": message["content"]}}]}
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode("utf-8"))
        for call in message.get("tool_calls", []):
            first = {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": call["id"], "function": {"name": call["function"]["name"]}}]}}]}
            self.wfile.write(("data: " + json.dumps(first) + "\n\n").encode("utf-8"))
            second = {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "function": {"arguments": call["function"]["arguments"]}}]}}]}
            self.wfile.write(("data: " + json.dumps(second) + "\n\n").encode("utf-8"))
        usage = {"choices": [], "usage": payload.get("usage")}
        self.wfile.write(("data: " + json.dumps(usage) + "\n\n").encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8731
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()

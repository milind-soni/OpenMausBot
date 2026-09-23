"""Exercise native Codex -> real LiteLLM -> synthetic provider HTTP protocols.

Run with a venv containing deploy/gateway/requirements.txt. No cloud credentials
or real desktop are used. Only sanitized assertion evidence is retained.
"""
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen
import zlib

import yaml

REPO = Path(__file__).resolve().parent.parent
CAPTURE = "SYNTHETIC_DESKTOP_CAPTURE"
evidence = {"requests": [], "ok": False}


def event_frame(kind, payload):
    headers = b""
    for name, value in {":message-type": "event", ":event-type": kind,
                        ":content-type": "application/json"}.items():
        key, val = name.encode(), value.encode()
        headers += bytes([len(key)]) + key + b"\x07" + struct.pack("!H", len(val)) + val
    data = json.dumps(payload).encode()
    prelude = struct.pack("!II", 16 + len(headers) + len(data), len(headers))
    message = prelude + struct.pack("!I", zlib.crc32(prelude)) + headers + data
    return message + struct.pack("!I", zlib.crc32(message))


def tool_name(value):
    if isinstance(value, dict):
        name = value.get("name", "")
        if "computer" in name and "screenshot" in name:
            return name
        for child in value.values():
            found = tool_name(child)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = tool_name(child)
            if found:
                return found
    return None


def has_image(value):
    if isinstance(value, dict):
        if value.get("type") == "input_image" and value.get("image_url", "").startswith("data:image/"):
            return True
        inline = value.get("inlineData", value.get("inline_data", {}))
        if inline.get("mimeType", inline.get("mime_type", "")).startswith("image/") and inline.get("data"):
            return True
        if value.get("image", {}).get("source", {}).get("bytes"):
            return True
        return any(has_image(child) for child in value.values())
    if isinstance(value, list):
        return any(has_image(child) for child in value)
    return False


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            route = "bedrock" if "converse" in self.path else "google" if "GenerateContent" in self.path else "azure"
            tools = body.get("tools", body.get("toolConfig", {}))
            name = tool_name(tools)
            namespace = next((t for t in tools if isinstance(t, dict) and t.get("name") == "mcp__computer"), None) if isinstance(tools, list) else None
            if namespace:
                name = "screenshot"
            assert name, f"{route}: computer tool missing"
            history = body.get("input", body.get("contents", body.get("messages", [])))
            has_result = CAPTURE in json.dumps(history)
            evidence["requests"].append({"route": route, "path": self.path.split("?")[0], "tool": name, "sawComputerResult": has_result, "sawImage": has_image(history)})
            call_id = "call_fixture"
            text = f"{route}: computer fixture verified"
            if route == "bedrock":
                assert self.headers.get("Authorization", "").startswith("AWS4-HMAC-SHA256 ")
                events = [("messageStart", {"role": "assistant"})]
                if has_result:
                    events += [("contentBlockDelta", {"contentBlockIndex": 0, "delta": {"text": text}})]
                else:
                    events += [("contentBlockStart", {"contentBlockIndex": 0, "start": {"toolUse": {"toolUseId": call_id, "name": name}}}),
                               ("contentBlockDelta", {"contentBlockIndex": 0, "delta": {"toolUse": {"input": "{}"}}})]
                events += [("contentBlockStop", {"contentBlockIndex": 0}),
                           ("messageStop", {"stopReason": "end_turn" if has_result else "tool_use"}),
                           ("metadata", {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}, "metrics": {"latencyMs": 1}})]
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.amazon.eventstream")
                self.end_headers()
                for kind, payload in events:
                    self.wfile.write(event_frame(kind, payload))
                return
            if route == "google":
                part = {"text": text} if has_result else {"functionCall": {"name": name, "args": {}}}
                events = [{"candidates": [{"content": {"role": "model", "parts": [part]}, "finishReason": "STOP", "index": 0}],
                           "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5, "totalTokenCount": 15}, "modelVersion": "gemini-3.8-flash"}]
            elif "responses" in self.path:
                item = {"id": "msg_fixture", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": text, "annotations": []}]} if has_result else {
                    "id": "fc_fixture", "type": "function_call", "call_id": call_id, "name": name, "arguments": "{}", "status": "completed",
                    **({"namespace": "mcp__computer"} if namespace else {})}
                response = {"id": "resp_fixture", "object": "response", "created_at": 1, "model": body["model"], "status": "completed", "output": [item], "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}
                events = [{"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                          {"type": "response.output_item.added", "output_index": 0, "item": item},
                          {"type": "response.output_item.done", "output_index": 0, "item": item},
                          {"type": "response.completed", "response": response}]
            else:
                delta = {"content": text} if has_result else {"tool_calls": [{"index": 0, "id": call_id, "type": "function", "function": {"name": name, "arguments": "{}"}}]}
                events = [{"id": "chatcmpl_fixture", "object": "chat.completion.chunk", "created": 1, "model": "gpt-5.6-sol", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                          {"id": "chatcmpl_fixture", "object": "chat.completion.chunk", "created": 1, "model": "gpt-5.6-sol", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop" if has_result else "tool_calls"}]}]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for event in events:
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
        except Exception as error:
            evidence["requests"].append({"error": str(error)})
            self.send_error(400, str(error))


def main():
    scratch = Path(tempfile.mkdtemp(prefix="omb-model-gateway-"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    upstream = f"http://127.0.0.1:{server.server_port}"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    config = yaml.safe_load((REPO / "deploy/gateway/config.yaml").read_text())
    for route in config["model_list"]:
        params = route["litellm_params"]
        if route["model_name"] == "gemini-3.8-flash":
            params["api_base"] = upstream + "/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse"
        elif route["model_name"] == "bedrock-claude":
            params["aws_bedrock_runtime_endpoint"] = upstream
    config_path = scratch / "config.yaml"
    config_path.write_text(yaml.safe_dump(config))
    # A whitelist prevents real model/AWS credentials or endpoint overrides from
    # reaching the gateway. The temporary HOME contains no provider config.
    env = {"PATH": os.environ["PATH"], "HOME": str(scratch), "LANG": "en_US.UTF-8",
           "OPENMAUS_MODEL_GATEWAY_KEY": "synthetic-gateway-key",
           "AZURE_MODEL": "azure/gpt-5.6-sol", "AZURE_OPENAI_ENDPOINT": upstream,
           "AZURE_OPENAI_API_KEY": "synthetic-azure-key", "AZURE_OPENAI_API_VERSION": "2025-04-01-preview",
           "GEMINI_API_KEY": "synthetic-google-key", "BEDROCK_MODEL": "bedrock/converse/us.anthropic.claude-sonnet-5",
           "AWS_REGION_NAME": "us-east-1", "AWS_ACCESS_KEY_ID": "synthetic-aws-id", "AWS_SECRET_ACCESS_KEY": "synthetic-aws-secret",
           "AWS_EC2_METADATA_DISABLED": "true", "LITELLM_LOCAL_MODEL_COST_MAP": "True", "DO_NOT_TRACK": "True", "LITELLM_TELEMETRY": "False"}
    child = None
    log_path = Path(str(scratch) + ".log")
    evidence_path = Path(str(scratch) + ".json")
    try:
        with log_path.open("w") as log:
            os.chmod(log_path, 0o600)
            child = subprocess.Popen([str(Path(sys.executable).parent / "litellm"), "--config", str(config_path), "--host", "127.0.0.1", "--port", str(port)], env=env, stdout=log, stderr=log)
            for _ in range(120):
                if child.poll() is not None:
                    raise RuntimeError(f"Gateway exited; fixture log: {log_path}")
                try:
                    with urlopen(f"http://127.0.0.1:{port}/health/liveliness", timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.5)
            else:
                raise RuntimeError(f"Gateway did not become ready; fixture log: {log_path}")
            probe_env = {**env, "PROBE_GATEWAY_URL": f"http://127.0.0.1:{port}/v1"}
            if os.environ.get("PROBE_CODEX"):
                probe_env["PROBE_CODEX"] = os.environ["PROBE_CODEX"]
            probe = subprocess.Popen(["node", "--experimental-strip-types", "scripts/verify-codex-providers.mjs"], cwd=REPO, env=probe_env, start_new_session=True)
            try:
                result = probe.wait(timeout=300)
                if result:
                    raise RuntimeError(f"Native Codex probe exited with status {result}")
            finally:
                # Bound the whole fixture process group, including Codex and
                # MCP children, even if Node times out before its own cleanup.
                try:
                    os.killpg(probe.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    probe.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(probe.pid, signal.SIGKILL)
                    probe.wait()
            for route in ("azure", "google", "bedrock"):
                calls = [r for r in evidence["requests"] if r.get("route") == route]
                assert any(not r["sawComputerResult"] for r in calls), f"{route}: no tool call"
                assert sum(r["sawComputerResult"] for r in calls) >= 2, f"{route}: missing result/resume"
                assert any(r["sawImage"] for r in calls), f"{route}: missing screenshot image"
            assert not any("error" in r for r in evidence["requests"])
            evidence["ok"] = True
            print("PASS: Azure, Gemini, and signed Bedrock protocol translation with native Codex and computer MCP.")
    finally:
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        server.shutdown()
        server.server_close()
        evidence_path.write_text(json.dumps(evidence, indent=2))
        os.chmod(evidence_path, 0o600)
        shutil.rmtree(scratch)
        print(f"Evidence: {evidence_path}\nFixture log: {log_path}")


if __name__ == "__main__":
    main()

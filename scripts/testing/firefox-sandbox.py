"""Read Firefox's about:support sandbox fields inside a disposable container.

Uses the bundled Marionette server on guest loopback and Python's standard
library only. No browser chrome/system access or published debug port.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

with tempfile.TemporaryDirectory(prefix="omb-firefox-sandbox-") as profile:
    env = dict(os.environ)
    if sys.argv[1] == "disabled":
        env["MOZ_DISABLE_CONTENT_SANDBOX"] = "1"
    with open(os.path.join(profile, "firefox.log"), "w+") as log:
        browser = subprocess.Popen(
            ["firefox-esr", "--headless", "--no-remote", "--marionette",
             "--profile", profile, "about:blank"],
            env=env, stdout=log, stderr=log,
        )
        connection = None
        try:
            deadline = time.monotonic() + 30
            while connection is None:
                if browser.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("Firefox did not start Marionette")
                try:
                    connection = socket.create_connection(("127.0.0.1", 2828), timeout=1)
                except OSError:
                    time.sleep(0.1)
            connection.settimeout(30)
            stream = connection.makefile("rb")

            def receive():
                length = b""
                while True:
                    byte = stream.read(1)
                    if not byte:
                        raise RuntimeError("Marionette disconnected")
                    if byte == b":":
                        break
                    length += byte
                return json.loads(stream.read(int(length)))

            receive()  # Protocol greeting.
            sequence = 0

            def command(name, parameters):
                global sequence
                sequence += 1
                payload = json.dumps([0, sequence, name, parameters]).encode()
                connection.sendall(str(len(payload)).encode() + b":" + payload)
                response = receive()
                if response[1] != sequence or response[2] is not None:
                    raise RuntimeError(str(response))
                return response[3]

            command("WebDriver:NewSession", {"capabilities": {}})
            command("WebDriver:Navigate", {"url": "about:support"})
            fields = {}
            deadline = time.monotonic() + 30
            while "effective-content-sandbox-level" not in fields:
                result = command("WebDriver:ExecuteScript", {
                    "script": "return Object.fromEntries(Array.from(document.querySelectorAll('#sandbox-tbody tr'), row => [row.querySelector('th').getAttribute('data-l10n-id'), row.querySelector('td').textContent]));",
                    "args": [], "newSandbox": True,
                })
                fields = result["value"]
                if time.monotonic() > deadline:
                    raise RuntimeError("Missing about:support sandbox fields: " + str(fields))
                time.sleep(0.1)
            print(json.dumps({
                "configuredContentSandboxLevel": int(fields["content-sandbox-level"]),
                "effectiveContentSandboxLevel": int(fields["effective-content-sandbox-level"]),
            }))
        except Exception:
            log.flush()
            log.seek(0)
            sys.stderr.write(log.read())
            raise
        finally:
            if connection is not None:
                connection.close()
            browser.terminate()
            try:
                browser.wait(timeout=10)
            except subprocess.TimeoutExpired:
                browser.kill()
                browser.wait(timeout=10)

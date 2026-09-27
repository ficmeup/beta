#!/bin/zsh
# Double-click to open Fic Listener in your browser. Close this window to stop it.
# While it runs, phones on the same Wi-Fi can open it too (the address is printed below).
cd "$(dirname "$0")"
PORT=8123
URL="http://localhost:$PORT/"
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)

show_phone_address() {
  if [[ -n "$LAN_IP" ]]; then
    echo ""
    echo "On your iPhone (same Wi-Fi), open Safari and go to:"
    echo "    http://$LAN_IP:$PORT/"
  fi
}

# Stop an older copy (it may have been started with different settings).
for pid in $(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null); do
  ps -o command= -p $pid | grep -q "http.server" && kill $pid
done
sleep 0.5

python3 -m http.server $PORT --bind 0.0.0.0 >/dev/null 2>&1 &
SERVER=$!
trap "kill $SERVER 2>/dev/null" EXIT

for i in {1..20}; do
  if curl -s -o /dev/null "$URL"; then
    open "$URL"
    echo "Fic Listener is running on this Mac at $URL"
    show_phone_address
    echo ""
    echo "Keep this window open while you use it. Close it to stop."
    wait $SERVER
    exit 0
  fi
  sleep 0.5
done

echo "Fic Listener couldn't start."
echo "If you installed Xcode, open it once and click Agree on its license, then try again."

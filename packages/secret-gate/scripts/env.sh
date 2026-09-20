# source this before launching an agent (or put it in the agent's tool env config)
export SECRET_GATE_HOME="${SECRET_GATE_HOME:-$HOME/.secret-gate}"
# Both cases on purpose: curl honours lowercase http_proxy only (httpoxy mitigation);
# many Node/Python libs read the uppercase form.
export HTTPS_PROXY=http://127.0.0.1:8080 https_proxy=http://127.0.0.1:8080
export HTTP_PROXY=http://127.0.0.1:8080  http_proxy=http://127.0.0.1:8080
export NO_PROXY=api.anthropic.com,.anthropic.com,claude.ai,.claude.ai,api.openai.com,api.deepseek.com,localhost
export no_proxy="$NO_PROXY"
export SSL_CERT_FILE="$SECRET_GATE_HOME/ca.pem"        # curl, openssl, most CLIs
export REQUESTS_CA_BUNDLE="$SSL_CERT_FILE"             # python requests / httpx
export NODE_EXTRA_CA_CERTS="$SSL_CERT_FILE"            # node, playwright

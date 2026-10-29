#!/bin/sh

# Ensure the script runs from its own directory
cd "$(dirname "$0")"

# Redirect output to stderr
exec 1>&2

echo "Running API checks..."
if ! npm run lint; then
    echo "Error: API lint failed."
    exit 1
fi

# Regenerate code into a scratch directory and compare it with the committed
# generated code. This catches protos edited without running 'npm run generate',
# as well as generator bumps (protoc-gen-go, protoc-gen-es, ...) that would
# change the generated output. Any real change to generated code lands under
# backend/ or frontend/, which in turn triggers those components' checks.
echo "Checking generated code is up to date..."
GEN_DIR=$(mktemp -d)
trap 'rm -rf "$GEN_DIR"' EXIT

# Every plugin output in buf.gen.yaml is relative to the repo root via "../";
# redirect them all into the scratch directory.
sed "s#out: \.\./#out: $GEN_DIR/#" buf.gen.yaml > "$GEN_DIR/buf.gen.yaml"
if grep -E '^[[:space:]]*out:' "$GEN_DIR/buf.gen.yaml" | grep -v -q -F "$GEN_DIR/"; then
    echo "Error: every 'out' in buf.gen.yaml must start with '../' for the generated code check."
    exit 1
fi

if ! npx buf generate --template "$GEN_DIR/buf.gen.yaml"; then
    echo "Error: API code generation failed."
    exit 1
fi
rm "$GEN_DIR/buf.gen.yaml"

# Mirror the post-processing done by 'npm run generate'.
if [ -d "$GEN_DIR/backend" ] && ! go tool goimports -w "$GEN_DIR/backend"; then
    echo "Error: goimports failed on generated code."
    exit 1
fi

STALE=$(find "$GEN_DIR" -type f | sed "s#^$GEN_DIR/##" | sort | while read -r f; do
    if ! cmp -s "$GEN_DIR/$f" "../$f"; then
        echo "  $f"
    fi
done)
if [ -n "$STALE" ]; then
    echo "Error: generated code is out of date. Run 'npm run generate' in api/ and commit the result."
    echo "$STALE"
    exit 1
fi

echo "API verification passed."

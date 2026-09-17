#!/usr/bin/env bash

set -euo pipefail

REPO="arklanq/zeus"
VERSION="${ZEUS_VERSION:-latest}"
RELEASE_BASE_URL="${ZEUS_RELEASE_BASE_URL:-https://github.com/${REPO}/releases}"
installer_args=()

usage() {
  cat <<'EOF'
Usage: install.sh [--version <tag>] [Zeus installer options]

Options:
  --version <tag>  Install a specific release, for example v1.2.3.
  --dry-run        Show changes without writing files.
  --skip-claude    Do not configure Claude Code.
  --skip-codex     Do not configure Codex.
  -h, --help       Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      if [ -z "${2:-}" ] || [[ "$2" == --* ]]; then
        echo "--version requires a release tag." >&2
        exit 1
      fi
      VERSION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --dry-run|--skip-claude|--skip-codex)
      installer_args+=("$1")
      shift
      ;;
    v[0-9]*)
      if [ "$VERSION" != "latest" ]; then
        echo "A release version was specified more than once." >&2
        exit 1
      fi
      VERSION="$1"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to install Zeus." >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "Unsupported operating system: $(uname -s)." >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)." >&2; exit 1 ;;
esac

binary_name="zeus-${os}-${arch}"
if [ "$VERSION" = "latest" ]; then
  download_base="${RELEASE_BASE_URL}/latest/download"
else
  download_base="${RELEASE_BASE_URL}/download/${VERSION}"
fi

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/zeus-install.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT
binary_path="${temporary_dir}/${binary_name}"
checksum_path="${binary_path}.sha256"

echo "Downloading Zeus ${VERSION} for ${os}-${arch}..."
curl -fsSL "${download_base}/${binary_name}" -o "$binary_path"
curl -fsSL "${download_base}/${binary_name}.sha256" -o "$checksum_path"

expected_checksum="$(awk -v name="$binary_name" '$2 == name { print $1 }' "$checksum_path")"
if [ "${#expected_checksum}" -ne 64 ] || [[ "$expected_checksum" == *[!0-9a-fA-F]* ]]; then
  echo "The downloaded checksum file is invalid." >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum="$(sha256sum "$binary_path" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum="$(shasum -a 256 "$binary_path" | awk '{ print $1 }')"
else
  echo "sha256sum or shasum is required to verify the download." >&2
  exit 1
fi

if [ "$actual_checksum" != "$expected_checksum" ]; then
  echo "SHA-256 verification failed. Refusing to run the downloaded file." >&2
  exit 1
fi

chmod +x "$binary_path"
if [ "${#installer_args[@]}" -eq 0 ]; then
  "$binary_path" install
else
  "$binary_path" install "${installer_args[@]}"
fi

install_dir="${ZEUS_BIN_DIR:-$HOME/.local/bin}"
if ! printf '%s' "$PATH" | tr ':' '\n' | grep -Fxq "$install_dir"; then
  echo
  echo "${install_dir} is not in PATH. Add it to your shell configuration:"
  echo "  export PATH=\"${install_dir}:\$PATH\""
fi

echo
echo "To uninstall later: ${install_dir}/zeus uninstall"

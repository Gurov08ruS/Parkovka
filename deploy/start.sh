#!/usr/bin/env bash
set -euo pipefail

systemctl start parkovka.service
systemctl is-active parkovka.service

# Security policy

## Reporting a vulnerability

Please use a private GitHub security advisory for vulnerabilities that could expose or destroy vault data. Do not include real vault contents, pairing keys, or other secrets in a public issue.

## Supported version

Only protocol version 2 is intended to receive security fixes. Version 1 should not be used with irreplaceable vault data.

## Operational guidance

- Generate pairing keys through the plugin rather than inventing a password.
- Pair only devices you control.
- Limit the host firewall rule to trusted local networks.
- Rotate the pairing key after suspected exposure or device loss.
- Keep independent, tested vault backups.
- Upgrade every paired device together when the protocol version changes.

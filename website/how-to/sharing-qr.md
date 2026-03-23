# Sharing & QR Codes

Generate share links with optional password protection and QR codes for quick mobile access.

## Generate a share link

```bash
relay share <session-id>
```

The link is read-only — viewers can see but not type. Default expiration is 1 hour.

## Password protection

```bash
relay share <session-id> --password mysecret
```

Viewers must enter the password before the terminal loads.

## Custom expiration

```bash
relay share <session-id> --ttl 300     # 5 minutes
relay share <session-id> --ttl 86400   # 24 hours (maximum)
```

## QR codes in the web UI

The share dialog in the web UI generates a QR code automatically. Scan it with a phone camera for instant access.

## From the web UI

1. Open a session
2. Tap the **share** icon
3. Set expiration and optional password
4. Copy the link or show the QR code

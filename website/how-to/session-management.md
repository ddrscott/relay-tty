# Session Management

How to create, list, attach, detach, and stop terminal sessions.

## Create a session

=== "CLI"

    ```bash
    relay bash                    # interactive shell
    relay htop                    # run a specific command
    relay --detach bash           # create without attaching (print URL)
    ```

=== "Web UI"

    Click the **+** button on the home page. Choose a shell or enter a custom command.

## List sessions

=== "CLI"

    ```bash
    relay list
    ```

=== "Web UI"

    The home page (`/`) shows all active sessions with their status and last activity.

## Attach to a session

=== "CLI"

    ```bash
    relay attach <session-id>
    ```

    Press ++ctrl+bracket-right++ to detach without killing the session.

=== "Web UI"

    Click any session in the list to open it in the terminal view.

## Stop a session

=== "CLI"

    ```bash
    relay stop <session-id>
    ```

=== "Web UI"

    Open the session info panel and tap **Stop**.

!!! warning
    Stopping a session kills the underlying process. This is not reversible.

## Multiple viewers

Multiple clients (CLI and browser) can connect to the same session simultaneously. Everyone sees the same output in real-time, and any connected client can type.

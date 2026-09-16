# spatial

A 3D file explorer. Fly through your filesystem.

Your folders are floating cards in a dark room. Move with WASD. Click to
enter. Files open in a panel — images render inline, text renders as
monospace. Everything you see is real. It's reading your actual disk.

Runs entirely on your machine. Nothing leaves it.

## Install

Requires Node 18 or newer.

    git clone https://github.com/YOURUSERNAME/spatial
    cd spatial
    npm install

## Run

    npm start

Then open **http://localhost:7331** in your browser.

By default it opens your home directory. To use a different root:

    SPATIAL_ROOT=/path/to/folder npm start

## Controls

| Key | Action |
|-----|--------|
| `W` `A` `S` `D` | Move |
| `Q` `E` | Down / up |
| Mouse | Look |
| Scroll | Move forward / back |
| Click | Open folder or file |
| `Backspace` | Go up one level |
| `Esc` | Close file viewer |

Hold `Shift` to move faster.

## How it works

Two pieces.

**The server** (Node.js) reads your filesystem and streams folder
contents over a WebSocket. It also serves the client. Every path is
resolved against the root and any attempt to escape it gets clamped
back — the browser can't access anything outside your home directory
(or whatever you set `SPATIAL_ROOT` to).

**The client** (in the browser) draws the file tree using Three.js.
It never touches the filesystem directly; it just asks the server for
listings and file contents.

This is the same architecture VS Code uses — a local process that has
file access, and a browser that doesn't.

## Why

Every file explorer is a list. Mine is a place.

## License

MIT

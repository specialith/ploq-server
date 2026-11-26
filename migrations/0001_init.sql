-- Ploq server: the whole schema. Accounts (by name), sign-ins, scores (projects), who's in
-- each score, invite links, and one-time codes ("Open in Ploq" and app sign-in).

CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

-- Sign-ins: only the SHA-256 of each token is stored. kind: "web" (browser) or "app".
CREATE TABLE tokens (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL,
    kind        TEXT NOT NULL
);

CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    title       TEXT NOT NULL,
    room        TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- role: "owner" or "editor".
CREATE TABLE members (
    project_id  TEXT NOT NULL REFERENCES projects(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    role        TEXT NOT NULL,
    joined_at   INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
);

CREATE TABLE invites (
    code        TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id),
    created_by  TEXT NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);

-- purpose: "open" (Open in Ploq, with project_id), "app" (browser -> app sign-in, with the app's
-- state and PKCE challenge) or "device" (sign another browser in). Stored hashed, single use,
-- a few minutes long.
CREATE TABLE login_codes (
    code_hash   TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    project_id  TEXT REFERENCES projects(id),
    purpose     TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    state       TEXT,
    challenge   TEXT
);

CREATE INDEX tokens_by_user ON tokens(user_id);
CREATE INDEX members_by_user ON members(user_id);
CREATE INDEX invites_by_project ON invites(project_id);
CREATE INDEX projects_by_owner ON projects(owner_id);

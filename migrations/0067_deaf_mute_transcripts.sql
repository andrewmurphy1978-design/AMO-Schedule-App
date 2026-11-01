-- A person who is deaf and mute (their voice and video messages come with a transcript); text transcript of voice/video messages in communities.
ALTER TABLE staff ADD COLUMN deaf_mute INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_media ADD COLUMN transcript TEXT;

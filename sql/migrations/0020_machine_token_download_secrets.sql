ALTER TABLE machine_tokens
    ADD COLUMN IF NOT EXISTS token_ciphertext text;

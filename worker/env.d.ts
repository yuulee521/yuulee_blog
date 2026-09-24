interface Env {
  /** Optional secret salt for hashing visitor IP + UA (`wrangler secret put VISITOR_SALT`). */
  VISITOR_SALT?: string;
}

#!/bin/sh
# Idempotent WordPress + WooCommerce provisioning, run by the Helm post-install/post-upgrade Job.
# Every step checks before it acts, so re-running after an upgrade only changes what drifted.
set -eu
cd /var/www/html

log() { printf '[setup] %s\n' "$*"; }

# WooCommerce's installer can exceed PHP's default 128M CLI limit; raise it for every wp call.
WP_BIN="$(command -v wp)"
wp() { php -d memory_limit=512M "$WP_BIN" "$@"; }

log "waiting for WordPress to write wp-config.php"
i=0
until [ -f wp-config.php ]; do
  i=$((i + 1)); [ "$i" -le 120 ] || { log "wp-config.php never appeared; is the wordpress pod running?"; exit 1; }
  sleep 3
done

log "waiting for the database"
i=0
db_check() {
  php -r '
    $db = new mysqli(
      getenv("WORDPRESS_DB_HOST"),
      getenv("WORDPRESS_DB_USER"),
      getenv("WORDPRESS_DB_PASSWORD"),
      getenv("WORDPRESS_DB_NAME"),
      3306
    );
    if ($db->connect_errno) {
      fwrite(STDERR, $db->connect_error . "\n");
      exit(1);
    }
    $db->close();
  '
}
until db_check >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -le 40 ] || { db_check || true; log "database never became reachable"; exit 1; }
  sleep 3
done

if ! wp core is-installed >/dev/null 2>&1; then
  log "installing WordPress"
  wp core install --url="$SITE_URL" --title="$STORE_NAME" --admin_user="$WP_ADMIN_USER" \
    --admin_password="$WP_ADMIN_PASSWORD" --admin_email="$WP_ADMIN_EMAIL" --skip-email
else
  # Keep the admin password in step with the Kubernetes Secret.
  wp user update "$WP_ADMIN_USER" --user_pass="$WP_ADMIN_PASSWORD" >/dev/null
fi
wp option update home "$SITE_URL" >/dev/null
wp option update siteurl "$SITE_URL" >/dev/null
wp option update timezone_string "$STORE_TIMEZONE" >/dev/null

current="$(wp plugin get woocommerce --field=version 2>/dev/null || true)"
if [ "$current" != "$WC_VERSION" ]; then
  log "installing WooCommerce $WC_VERSION (was: ${current:-none})"
  wp plugin install woocommerce --version="$WC_VERSION" --force
fi
wp plugin is-active woocommerce >/dev/null 2>&1 || wp plugin activate woocommerce

log "configuring the store"
wp option update woocommerce_currency "$STORE_CURRENCY" >/dev/null
wp option update woocommerce_default_country "$STORE_COUNTRY" >/dev/null
# Newer WooCommerce versions start new stores in "coming soon" mode, which hides the storefront.
wp option update woocommerce_coming_soon no >/dev/null
wp option update woocommerce_store_pages_only no >/dev/null
wp option update woocommerce_cod_settings \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay when your order arrives.","enable_for_methods":[],"enable_for_virtual":"yes"}' --format=json >/dev/null
wp option update permalink_structure '/%postname%/' >/dev/null
wp wc tool run install_pages --user="$WP_ADMIN_USER" >/dev/null 2>&1 || true
wp rewrite flush --hard >/dev/null 2>&1 || log "could not write .htaccess; woo-mcp needs /wp-json/ to route, so check the WordPress volume is writable"

# A dedicated shop-manager user owns the API key, so the MCP server holds far less power than an administrator.
if ! wp user get mcp-portal-mcp >/dev/null 2>&1; then
  log "creating the mcp-portal-mcp service user (shop_manager)"
  wp user create mcp-portal-mcp mcp-portal-mcp@invalid.example --role=shop_manager \
    --user_pass="$(head -c 24 /dev/urandom | base64)" --porcelain >/dev/null
fi

log "installing the WooCommerce REST API key for woo-mcp"
wp eval '
global $wpdb;
$user = get_user_by("login", "mcp-portal-mcp");
$ck = getenv("WOO_CONSUMER_KEY");
$cs = getenv("WOO_CONSUMER_SECRET");
if (!$user || !$ck || !$cs) { fwrite(STDERR, "missing user or key material\n"); exit(1); }
$table = $wpdb->prefix . "woocommerce_api_keys";
$wpdb->delete($table, array("description" => "mcp-portal-mcp"));
$ok = $wpdb->insert($table, array(
  "user_id" => $user->ID,
  "description" => "mcp-portal-mcp",
  "permissions" => "read_write",
  "consumer_key" => wc_api_hash($ck),
  "consumer_secret" => $cs,
  "truncated_key" => substr($ck, -7),
));
if (!$ok) { fwrite(STDERR, "could not store the API key: " . $wpdb->last_error . "\n"); exit(1); }
echo "API key stored\n";
'

if [ "${DEMO_PRODUCTS:-false}" = "true" ]; then
  log "ensuring HMT demo watch catalog exists"
  # Remove only the four legacy demo products from this chart's previous seed.
  for legacy_sku in COFFEE-500 CHIPS-250 SCARF-KAN DIYA-6; do
    legacy_ids="$(wp post list --post_type=product --meta_key=_sku --meta_value="$legacy_sku" --format=ids 2>/dev/null || true)"
    for legacy_id in $legacy_ids; do
      [ -n "$legacy_id" ] && wp post delete "$legacy_id" --force >/dev/null
    done
  done
  ensure_product() {
    name="$1"; sku="$2"; price="$3"; description="$4"
    existing_id="$(wp post list --post_type=product --meta_key=_sku --meta_value="$sku" --format=ids 2>/dev/null | awk '{print $1}')"
    if [ -n "$existing_id" ]; then
      wp wc product update "$existing_id" --user="$WP_ADMIN_USER" --name="$name" --regular_price="$price" --manage_stock=true --stock_quantity=25 --status=publish --description="$description" >/dev/null
      log "updated $name ($sku)"
    else
      wp wc product create --user="$WP_ADMIN_USER" --name="$name" --sku="$sku" --regular_price="$price" --type=simple --manage_stock=true --stock_quantity=25 --status=publish --description="$description" --porcelain >/dev/null
      log "created $name ($sku)"
    fi
  }
  ensure_product "HMT Pilot" "HMT-PILOT" "3499" "Demo listing inspired by the classic HMT Pilot design. Verify model, movement, condition, and authenticity with the seller before purchase."
  ensure_product "HMT Sona" "HMT-SONA" "2999" "Demo listing inspired by the HMT Sona gold-tone vintage style. Listing price is illustrative; authenticity and condition are not certified."
  ensure_product "HMT Kohinoor" "HMT-KOHINOOR" "2799" "Demo listing inspired by the classic HMT Kohinoor. Verify the exact variant, movement, condition, and authenticity with the seller."
  ensure_product "HMT Janata" "HMT-JANATA" "2499" "Demo listing inspired by the HMT Janata mechanical watch style. Listing price is illustrative; authenticity and condition are not certified."
fi

log "done"

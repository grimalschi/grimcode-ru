FROM adminer:5.4.2-standalone

USER root
COPY --chown=adminer:adminer index.php /var/www/html/index.php
COPY --chown=adminer:adminer adminer.css /var/www/html/adminer.css
RUN chmod 0644 /var/www/html/index.php /var/www/html/adminer.css
USER adminer

# Gateway proxies without rewriting the path, so Adminer is reached at
# /admin/service/adminer/**. The base image runs PHP's built-in server with a document root only,
# which would answer 404 for every such path. Passing index.php as the router script routes every
# request to the existing wrapper, which already reads REQUEST_URI. Nothing about the wrapper, its
# DOM transformations or the stylesheet changes.
CMD ["php", "-S", "[::]:8080", "-t", "/var/www/html", "/var/www/html/index.php"]

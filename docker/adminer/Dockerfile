FROM adminer:5.4.2-standalone

USER root
COPY --chown=adminer:adminer index.php /var/www/html/index.php
COPY --chown=adminer:adminer adminer.css /var/www/html/adminer.css
RUN chmod 0644 /var/www/html/index.php /var/www/html/adminer.css
USER adminer

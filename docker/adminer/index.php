<?php
declare(strict_types=1);

function template_adminer_database_url(): ?array
{
    $value = getenv('DATABASE_URL');
    if (is_string($value) && $value !== '') {
        $parsed = parse_url($value);
        return is_array($parsed) ? $parsed : null;
    }
    return null;
}

function template_adminer_env(string $key): string
{
    $value = getenv($key);
    return is_string($value) ? $value : '';
}

function template_adminer_url_part(?array $databaseUrl, string $key): string
{
    if ($databaseUrl === null || !array_key_exists($key, $databaseUrl)) return '';
    $value = $databaseUrl[$key];
    if (!is_string($value) && !is_int($value)) return '';
    return rawurldecode((string) $value);
}

function template_adminer_server(?array $databaseUrl): string
{
    $server = template_adminer_env('TEMPLATE_ADMINER_SERVER');
    if ($server !== '') return $server;
    $host = template_adminer_url_part($databaseUrl, 'host');
    if ($host === '') return 'postgres';
    $port = template_adminer_url_part($databaseUrl, 'port');
    return $port === '' ? $host : $host . ':' . $port;
}

function template_adminer_login_part(string $envKey, ?array $databaseUrl, string $urlKey, string $default): string
{
    $value = template_adminer_env($envKey);
    if ($value !== '') return $value;
    $value = template_adminer_url_part($databaseUrl, $urlKey);
    return $value === '' ? $default : $value;
}

function template_adminer_filter_html(string $html): string
{
    $html = preg_replace("~<link rel='stylesheet'[^>]*href='[^']*\\?file=dark\\.css[^']*'>\\s*~", '', $html) ?? $html;
    $html = preg_replace("~<meta name='color-scheme' content='[^']*'>~", "<meta name='color-scheme' content='light dark'>", $html) ?? $html;
    $html = preg_replace('~<meta name="color-scheme" content="[^"]*">~', '<meta name="color-scheme" content="light dark">', $html) ?? $html;
    $nonceAttribute = '';
    if (preg_match('~<script\b[^>]*\snonce=(["\'])([^"\']+)\1~i', $html, $nonceMatches) === 1) {
        $nonceAttribute = ' nonce="' . htmlspecialchars($nonceMatches[2], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '"';
    }
    $themeCode = <<<'JS'
(() => {
    const applyTheme = (theme) => {
        if (theme === 'light' || theme === 'dark') {
            document.documentElement.dataset.theme = theme;
        } else if (theme === 'system') {
            document.documentElement.removeAttribute('data-theme');
        }
    };
    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin || event.data?.type !== 'template.admin.theme') return;
        applyTheme(event.data.theme);
    });
})();
JS;
    $themeBridge = "<script{$nonceAttribute}>\n{$themeCode}\n</script>";
    $html = preg_replace('~<body\b~i', $themeBridge . "\n<body", $html, 1) ?? $html;
    $html = preg_replace_callback(
        '~(<fieldset><legend><a [^>]*>Page</a></legend>.*?</script>)(.*?)(</fieldset>)~s',
        static function (array $matches): string {
            $wrapped = false;
            $parts = preg_split('~(<a\b[^>]*>.*?</a>)~s', $matches[2], -1, PREG_SPLIT_DELIM_CAPTURE);

            if (!is_array($parts)) {
                return $matches[0];
            }

            foreach ($parts as $index => $part) {
                if ($wrapped || str_starts_with(ltrim($part), '<a')) {
                    continue;
                }

                $parts[$index] = preg_replace(
                    '~(^|\s)(\d+)(?=\s|$)~',
                    '$1<span class="page-current">$2</span>',
                    $part,
                    1,
                    $count
                ) ?? $part;
                $wrapped = $count > 0;
            }

            return $matches[1] . implode('', $parts) . $matches[3];
        },
        $html
    ) ?? $html;
    return $html;
}

function template_adminer_request_path(): string
{
    foreach (['DOCUMENT_URI', 'REQUEST_URI'] as $key) {
        $value = $_SERVER[$key] ?? '';
        if (!is_string($value) || $value === '') continue;
        $path = parse_url($value, PHP_URL_PATH);
        if (is_string($path) && $path !== '') return $path;
    }
    return '';
}

if (basename(template_adminer_request_path()) === 'adminer.css' && is_readable(__DIR__ . '/adminer.css')) {
    header('Content-Type: text/css; charset=utf-8');
    header('Cache-Control: public, max-age=31536000, immutable');
    readfile(__DIR__ . '/adminer.css');
    exit;
}

$databaseUrlConfig = template_adminer_database_url();
if (!isset($_GET['username']) && !isset($_POST['auth']) && !isset($_GET['file'])) {
    $_SERVER['REQUEST_METHOD'] = 'POST';
    $_POST['auth'] = [
        'driver' => 'pgsql',
        'server' => template_adminer_server($databaseUrlConfig),
        'username' => template_adminer_login_part('TEMPLATE_ADMINER_USERNAME', $databaseUrlConfig, 'user', 'template'),
        'password' => template_adminer_login_part('TEMPLATE_ADMINER_PASSWORD', $databaseUrlConfig, 'pass', 'template'),
        'db' => '',
    ];
}

function adminer_object()
{
    class TemplateAdminer extends Adminer\Adminer
    {
        public function name()
        {
            return 'Project DB';
        }

        public function headers()
        {
            header_remove('X-Frame-Options');
        }

        public function css()
        {
            $themePath = __DIR__ . '/adminer.css';
            $themeHash = is_readable($themePath) ? sha1_file($themePath) : false;
            $themeVersion = is_string($themeHash) ? substr($themeHash, 0, 12) : '1';
            return ['adminer.css?v=' . $themeVersion => 'all'];
        }
    }
    return new TemplateAdminer();
}

ob_start('template_adminer_filter_html');
require 'adminer.php';

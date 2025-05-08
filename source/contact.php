<?php
// contact.php
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit;
}

// Simple sanitization
$name    = strip_tags(trim($_POST['name']    ?? ''));
$email   = filter_var(trim($_POST['email']  ?? ''), FILTER_VALIDATE_EMAIL);
$subject = strip_tags(trim($_POST['subject'] ?? ''));
$message = strip_tags(trim($_POST['message'] ?? ''));

if (!$name || !$email || !$subject || !$message) {
    echo '<div class="msg-failed">Please fill in all fields correctly.</div>';
    exit;
}

$to      = 'quinnsavitt@gmail.com';
$headers = "From: {$name} <{$email}>\r\n"
         . "Reply-To: {$email}\r\n"
         . "Content-Type: text/plain; charset=UTF-8\r\n";

$body  = "You have received a new message from your website contact form.\n\n";
$body .= "Name: {$name}\n";
$body .= "Email: {$email}\n";
$body .= "Subject: {$subject}\n\n";
$body .= "Message:\n{$message}\n";

if (mail($to, $subject, $body, $headers)) {
    echo '<div class="msg-success">Your Message was sent successfully.</div>';
} else {
    echo '<div class="msg-failed">Something went wrong, please try again later.</div>';
}

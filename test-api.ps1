# Test de création de propriété
Write-Host "=== Test API Propriétés ===" -ForegroundColor Cyan

$headers = @{
    "Content-Type" = "application/json"
}

# Créer/Connecter un utilisateur
Write-Host "`n1. Authentification..." -ForegroundColor Yellow

$email = "test@example.com"
$password = "Test1234!"

$registerBody = @{
    email = $email
    password = $password
}

$registerJson = $registerBody | ConvertTo-Json

try {
    $response = Invoke-WebRequest -Uri "http://localhost:3000/api/auth/register" -Method POST -Headers $headers -Body $registerJson -UseBasicParsing
    $data = $response.Content | ConvertFrom-Json
    $token = $data.token
    Write-Host "✓ Nouveau compte créé" -ForegroundColor Green
}
catch {
    # Essayer de se connecter si le compte existe
    $loginBody = @{ email = $email; password = $password }
    $loginJson = $loginBody | ConvertTo-Json
    
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:3000/api/auth/login" -Method POST -Headers $headers -Body $loginJson -UseBasicParsing
        $data = $response.Content | ConvertFrom-Json
        $token = $data.token
        Write-Host "✓ Connexion réussie" -ForegroundColor Green
    }
    catch {
        Write-Host "✗ Authentification échouée" -ForegroundColor Red
        exit 1
    }
}

# Créer une propriété
Write-Host "`n2. Création d'une propriété..." -ForegroundColor Yellow

$authHeaders = @{
    "Content-Type" = "application/json"
    "Authorization" = "Bearer $token"
}

$property = @{
    name = "Villa Test PowerShell"
    property_type = "villa"
    bedrooms = 3
    beds = 4
    bathrooms = 2
    max_guests = 6
    has_wifi = $true
    has_kitchen = $true
    has_pool = $true
    has_parking = $true
    description = "Test villa created from PowerShell"
}

$propertyJson = $property | ConvertTo-Json

try {
    $response = Invoke-WebRequest -Uri "http://localhost:3000/api/properties" -Method POST -Headers $authHeaders -Body $propertyJson -UseBasicParsing
    $data = $response.Content | ConvertFrom-Json
    Write-Host "✓ Propriété créée!" -ForegroundColor Green
    Write-Host "  ID: $($data.property.id)" -ForegroundColor White
    Write-Host "  Nom: $($data.property.name)" -ForegroundColor White
    Write-Host "  Type: $($data.property.property_type)" -ForegroundColor White
}
catch {
    Write-Host "✗ Erreur de création:" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host "  $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
    else {
        Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    }
}

# Lister les propriétés
Write-Host "`n3. Liste des propriétés..." -ForegroundColor Yellow

try {
    $response = Invoke-WebRequest -Uri "http://localhost:3000/api/properties" -Method GET -Headers $authHeaders -UseBasicParsing
    $properties = $response.Content | ConvertFrom-Json
    Write-Host "✓ $($properties.Count) propriété(s) trouvée(s)" -ForegroundColor Green
    
    foreach ($prop in $properties) {
        Write-Host "  - $($prop.name) ($($prop.property_type), $($prop.bedrooms) chambres)" -ForegroundColor White
    }
}
catch {
    Write-Host "✗ Erreur de récupération" -ForegroundColor Red
}

Write-Host "`n=== Test terminé ===" -ForegroundColor Cyan

# Test de création de propriété
$headers = @{
    "Content-Type" = "application/json"
}

# D'abord, créer un utilisateur et obtenir un token
Write-Host "1. Création d'un compte test..." -ForegroundColor Cyan
$registerBody = @{
    email = "test@example.com"
    password = "Test1234!"
} | ConvertTo-Json

try {
    $registerResponse = Invoke-WebRequest -Uri "http://localhost:3000/api/auth/register" `
        -Method POST `
        -Headers $headers `
        -Body $registerBody `
        -UseBasicParsing `
        -ErrorAction Stop
    
    $registerData = $registerResponse.Content | ConvertFrom-Json
    $token = $registerData.token
    Write-Host "✓ Compte créé, token obtenu" -ForegroundColor Green
} catch {
    # Si le compte existe déjà, essayer de se connecter
    Write-Host "Compte existe déjà, tentative de connexion..." -ForegroundColor Yellow
    $loginBody = @{
        email = "test@example.com"
        password = "Test1234!"
    } | ConvertTo-Json
    
    try {
        $loginResponse = Invoke-WebRequest -Uri "http://localhost:3000/api/auth/login" `
            -Method POST `
            -Headers $headers `
            -Body $loginBody `
            -UseBasicParsing `
            -ErrorAction Stop
        
        $loginData = $loginResponse.Content | ConvertFrom-Json
        $token = $loginData.token
        Write-Host "✓ Connecté, token obtenu" -ForegroundColor Green
    } catch {
        Write-Host "✗ Erreur de connexion: $($_.Exception.Message)" -ForegroundColor Red
        exit
    }
}

# Maintenant, créer une propriété
Write-Host "`n2. Création d'une propriété test..." -ForegroundColor Cyan
$headersWithAuth = @{
    "Content-Type" = "application/json"
    "Authorization" = "Bearer $token"
}

$propertyBody = @{
    name = "Villa Test"
    property_type = "villa"
    bedrooms = 3
    beds = 4
    bathrooms = 2
    max_guests = 6
    has_wifi = $true
    has_kitchen = $true
    has_pool = $true
    has_parking = $true
    has_air_conditioning = $true
    description = "Belle villa de test"
}
$propertyJson = $propertyBody | ConvertTo-Json

try {
    $propertyResponse = Invoke-WebRequest -Uri "http://localhost:3000/api/properties" `
        -Method POST `
        -Headers $headersWithAuth `
        -Body $propertyJson `
        -UseBasicParsing `
        -ErrorAction Stop
    
    $propertyData = $propertyResponse.Content | ConvertFrom-Json
    Write-Host "✓ Propriété créée avec succès!" -ForegroundColor Green
    Write-Host "  ID: $($propertyData.property.id)" -ForegroundColor White
    Write-Host "  Nom: $($propertyData.property.name)" -ForegroundColor White
    Write-Host "  Type: $($propertyData.property.property_type)" -ForegroundColor White
} catch {
    Write-Host "✗ Erreur lors de la création de la propriété:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($_.ErrorDetails) {
        Write-Host $_.ErrorDetails.Message -ForegroundColor Red
    }
}

# Récupérer la liste des propriétés
Write-Host "`n3. Récupération de la liste des propriétés..." -ForegroundColor Cyan
try {
    $listResponse = Invoke-WebRequest -Uri "http://localhost:3000/api/properties" `
        -Method GET `
        -Headers $headersWithAuth `
        -UseBasicParsing `
        -ErrorAction Stop
    
    $properties = $listResponse.Content | ConvertFrom-Json
    Write-Host "✓ $($properties.Count) propriété(s) trouvée(s)" -ForegroundColor Green
    foreach ($prop in $properties) {
        Write-Host "  - $($prop.name) ($($prop.property_type))" -ForegroundColor White
    }
} catch {
    Write-Host "✗ Erreur lors de la récupération: $($_.Exception.Message)" -ForegroundColor Red
}

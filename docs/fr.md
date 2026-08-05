# Saunier Duval

Cette intégration relie Gladys Assistant à votre chauffage Saunier Duval via le
cloud du groupe Vaillant — le même service que celui utilisé par l'application
**MiGo** sur votre téléphone.

Elle vous permet de :

- lire la température ambiante mesurée par le thermostat ;
- lire l'humidité mesurée par le thermostat (selon le modèle) ;
- lire la température extérieure ;
- lire l'état de la chaudière (en train de chauffer ou à l'arrêt) ;
- lire la température de consigne ;
- **modifier** la température de consigne ;
- **modifier** l'état de la chaudière (allumer ou éteindre le chauffage).

## Matériel compatible

Toute installation Saunier Duval déjà pilotée depuis l'application MiGo :

- passerelle **MiGo** ou **MiGo Link** associée à une chaudière (ThemaPlus
  Condens, Isotwin, Duomax…) ;
- régulations basées sur un contrôleur **VRC700** (MiPro, MiPro Sense).

Une même installation peut comporter plusieurs zones de chauffage : Gladys crée
alors un thermostat par zone.

> Les comptes **Bulex** (Belgique) utilisent le même service, mais un pays
> différent de ceux proposés ici. Cette intégration cible les comptes Saunier
> Duval.

## Prérequis

1. Une passerelle MiGo déjà installée et **appairée dans l'application MiGo**.
   Cette intégration ne fait pas l'appairage : elle lit le compte, elle ne le
   configure pas.
2. L'adresse e-mail et le mot de passe de ce compte MiGo.
3. Le **pays** dans lequel le compte a été créé. C'est la cause d'erreur la plus
   fréquente : un pays incorrect fait échouer la connexion, même avec un mot de
   passe valide.

## Configuration

Dans Gladys, ouvrez la configuration de l'intégration et renseignez :

| Champ                              | Description                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Adresse e-mail**                 | L'identifiant de votre compte MiGo.                                                                |
| **Mot de passe**                   | Le mot de passe du compte. Il est stocké chiffré par Gladys et n'est jamais renvoyé au navigateur. |
| **Pays**                           | Le pays d'enregistrement du compte (France par défaut).                                            |
| **Quand le chauffage est allumé**  | Le mode auquel la zone revient quand vous rallumez le chauffage.                                   |
| **Durée d'un forçage temporaire**  | La durée d'une consigne posée alors que la zone suit son programme.                                |
| **Intervalle de rafraîchissement** | La fréquence de lecture des mesures, en secondes.                                                  |

Cliquez ensuite sur **Tester la connexion** : le bouton affiche les
installations trouvées sur le compte et les températures lues. Si ce test passe,
tout le reste fonctionnera.

## Appareils créés

Pour chaque installation, Gladys crée deux appareils.

**Le thermostat** (un par zone de chauffage) :

| Fonctionnalité             | Lecture / écriture |
| -------------------------- | ------------------ |
| Température                | Lecture            |
| Humidité                   | Lecture            |
| Température de consigne    | Lecture + écriture |
| Chauffage (marche / arrêt) | Lecture + écriture |

**La chaudière** (une par installation) :

| Fonctionnalité         | Lecture / écriture |
| ---------------------- | ------------------ |
| Température extérieure | Lecture            |
| État de la chaudière   | Lecture            |
| Pression d'eau         | Lecture            |

L'humidité et la pression d'eau ne sont créées que si votre installation les
remonte réellement.

## Comment la consigne est appliquée

Le comportement dépend du mode dans lequel se trouve la zone, afin que la valeur
choisie dans Gladys soit bien celle que le régulateur vise :

- **La zone suit son programme hebdomadaire** → un forçage temporaire est
  appliqué, exactement comme si vous tourniez la molette du thermostat. Il dure
  le nombre d'heures configuré, puis le programme reprend la main.
- **La zone est en mode manuel** → la consigne manuelle est modifiée
  durablement.
- **La zone est éteinte** → le chauffage est rallumé en mode manuel à la
  température demandée : demander une température, c'est demander de la chaleur.

Le bouton **Chauffage** éteint la zone (mode `OFF`) ou la rallume dans le mode
choisi dans la configuration (programme hebdomadaire par défaut).

## Limites connues

- **La passerelle est lente.** Elle ne remonte ses mesures au cloud que toutes
  les quelques minutes : descendre l'intervalle de rafraîchissement sous 300
  secondes n'apporte rien et multiplie les appels.
- **Un changement met un moment à apparaître.** Après une commande, le cloud
  peut mettre une à deux minutes à refléter la nouvelle valeur.
- **API non publique.** Saunier Duval ne documente pas cette API : elle est
  utilisée par l'application mobile. Elle peut évoluer sans préavis.
- **Un seul compte à la fois.** L'intégration lit toutes les installations d'un
  compte, mais un seul compte peut être configuré.

## En cas de problème

- **« Connexion refusée »** : vérifiez l'adresse e-mail, le mot de passe et
  surtout le **pays**. Essayez de vous connecter dans l'application MiGo pour
  confirmer que le compte fonctionne.
- **Aucun appareil n'apparaît** : lancez **Tester la connexion**. Si aucune
  installation n'est trouvée, c'est que la passerelle n'est pas rattachée à ce
  compte.
- **Les valeurs ne bougent plus** : consultez les logs du conteneur de
  l'intégration (`LOG_LEVEL=debug` pour le détail des appels).

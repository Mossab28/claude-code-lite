# claude-code-lite (`ccl`) — spécification de conception

Date : 2026-08-08

## Problème

Claude Code consomme énormément de bande passante montante, et personne ne le
sait parce que rien ne le mesure.

Mesures relevées sur de vraies sessions locales (transcripts `~/.claude/projects`,
dédupliqués par `message.id`, tokens convertis à ~3,6 octets/token) :

| session | appels API | uploadé | téléchargé |
|---|---|---|---|
| 549 tours | 549 | 851 Mo | 6 Mo |
| 674 tours | 674 | 835 Mo | 6 Mo |
| 159 tours | 159 | 183 Mo | 3 Mo |

L'upload dépasse le download d'un facteur ~100. La cause est structurelle :
l'API Messages est sans état, donc le client renvoie l'intégralité de la
conversation à chaque appel. Le cache de prompt économise du calcul côté
serveur, pas des octets sur le fil.

Deux conséquences dirigent toute la conception :

1. **Le coût est quadratique dans la longueur de session.** Chaque octet ajouté
   au contexte est repayé à tous les tours restants.
2. **Chaque appel d'outil est un tour complet.** Un `ls` sur un contexte de
   200k tokens coûte ~700 Ko d'upload, autant qu'une vraie question.

Corollaire contre-intuitif, et thèse du projet : **un Claude qui raisonne plus
consomme moins de réseau.** Le raisonnement est du token de sortie, il descend
et pèse ~6 Mo par session. Le tâtonnement est du token d'entrée, il remonte
tout le contexte à chaque appel d'outil.

## Principes

1. **L'efficacité de Claude ne baisse jamais.** Tout levier qui échange de la
   qualité contre des octets est écarté, même s'il est rentable en octets.
2. **Zéro infrastructure.** On installe, on lance `ccl`. Pas de serveur, pas de
   compte, pas de service tiers.
3. **Surface produit minimale.** L'utilisateur voit sa consommation baisser. Il
   n'a pas à comprendre comment.
4. **Mesurer avant d'affirmer.** Le compteur d'octets est la seule source de
   vérité ; chaque levier se justifie contre lui.
5. **Pas de fork.** `ccl` enveloppe le vrai `claude` et ne duplique rien de
   l'amont.

## Hors périmètre

- **Relais delta sur serveur distant.** Techniquement le levier le plus
  puissant (×20 à ×50, en n'envoyant que le diff entre requêtes successives),
  mais il exige un serveur que l'utilisateur n'a pas, et il déchiffrerait la
  conversation. Écarté.
- **Compactage agressif du contexte.** Peut se retourner : perdre du contexte
  fait recommencer du travail, donc plus de tours, donc plus d'octets — en plus
  de violer le principe 1.
- **Modèle local pour résumer les sorties d'outils.** Gros chantier ; 90 % du
  bénéfice est déjà capté par un plafond de troncature déterministe.
- **Fork ou réimplémentation de Claude Code.**

## Architecture

`ccl` place un proxy local sur le chemin réseau, puis exécute le vrai `claude`
au travers.

```
claude (processus enfant)  →  127.0.0.1:<port éphémère>  →  api.anthropic.com
                                     proxy ccl
                            mesure · compresse · allège · garde
```

### Unités

Chacune a une responsabilité unique et se teste isolément.

- **`bin/ccl`** — lanceur. Construit l'environnement, démarre le proxy sur un
  port éphémère, exporte `ANTHROPIC_BASE_URL`, lance `claude` en processus
  enfant en lui passant tous les arguments reçus (donc `ccl --resume` marche),
  imprime le rapport à la sortie et propage le code de retour de l'enfant.
- **`src/proxy.js`** — serveur HTTP local. Transfert intégral des en-têtes, y
  compris l'authentification, qui n'est jamais lue ni stockée. La réponse SSE
  est repiquée sans tampon : bufferiser tuerait le streaming et rendrait
  l'outil inutilisable.
- **`src/meter.js`** — comptabilité. Octets réels dans les deux sens, par
  requête, écrits dans un journal JSONL sous `~/.ccl/`. Attribue chaque octet à
  une catégorie (texte, images, schémas d'outils, sorties d'outils) pour
  pouvoir nommer le coupable.
- **`src/levers/`** — un module par levier de réduction, chacun une fonction
  pure `(corpsRequête) → corpsRequête` accompagnée de son économie mesurée.
- **`src/guard.js`** — garde-fou. Suit le cumul de session et le poids par
  requête, avertit, et interrompt au plafond.
- **`presets/`** — variables d'environnement, fragment `settings.json`, style
  de sortie.

### Flux

1. `bin/ccl` démarre le proxy et lance `claude`.
2. Claude Code émet une requête vers le proxy.
3. Le proxy mesure le corps brut, applique les leviers dans l'ordre, mesure le
   corps final, consulte le garde-fou.
4. Le corps est transmis à `api.anthropic.com`, éventuellement compressé.
5. La réponse SSE est repiquée octet par octet vers Claude Code, sans tampon.
6. `meter` enregistre la ligne ; la statusline se met à jour.
7. À la sortie de l'enfant, `bin/ccl` imprime le rapport de session.

## Leviers

Ordre d'application, gain estimé sur une session de référence à 851 Mo, et
risque pour la qualité.

| # | levier | gain | risque |
|---|---|---|---|
| 1 | Réduction des images anciennes | jusqu'à −60 % | nul (conservateur) |
| 2 | Compression du corps de requête | ×4 à ×5 | nul |
| 3 | Plafond sur les sorties d'outils | −10 à −20 % | faible |
| 4 | Schémas d'outils différés, MCP coupé | −15 % | nul |
| 5 | Hygiène d'environnement | dizaines de Mo/mois | nul |
| 6 | Réutilisation de connexion, reprise TLS | −0,5 % | nul |
| 7 | Préréglages de raisonnement et de groupage | indirect | négatif (améliore) |

### 1. Réduction des images anciennes

Une capture d'écran pèse 1 à 2 Mo en base64 et elle est réexpédiée à chaque
tour suivant. Une seule capture au tour 20 d'une session de 300 tours coûte
~400 Mo. C'est le premier poste réel pour quiconque envoie des captures.

Règle, volontairement conservatrice : les **trois images les plus récentes**
passent intactes. Au-delà, l'image est réencodée à 1024 px de large maximum, en
JPEG qualité 70. **Aucune image n'est jamais supprimée** — Claude garde ce
qu'il regarde en ce moment, et une version dégradée de ce qu'il a déjà exploité.

Actif par défaut.

### 2. Compression du corps de requête

Du JSON en anglais compresse d'un facteur 4 à 5 en gzip. C'est le levier sans
perte le plus large. **Conditionné à la vérification n° 2 ci-dessous.**

Actif par défaut si l'API l'accepte, silencieusement inactif sinon.

### 3. Plafond sur les sorties d'outils

Une commande bavarde entre dans le contexte et y reste pour toujours. Plafond
par défaut à 32 Ko par résultat d'outil, tronqué au milieu — le début et la fin
d'une sortie portent l'information, le ventre rarement — avec une marque
explicite du nombre de lignes retirées, pour que Claude sache qu'il manque
quelque chose et puisse redemander.

Actif par défaut.

### 4. Schémas d'outils différés, MCP coupé

Les schémas d'outils sont réexpédiés à chaque requête. Soixante-quinze outils
de connecteurs représentent environ 50k tokens par tour, soit ~100 Mo sur une
longue session. Le préréglage force le chargement différé des schémas et
n'active aucun serveur MCP par défaut.

### 5. Hygiène d'environnement

Télémétrie, remontée d'erreurs, auto-updater et appels modèle non essentiels
désactivés. Hors API, mais c'est de la data — l'auto-updater seul peut
représenter des dizaines de mégaoctets par mois.

### 6. Réutilisation de connexion

Keep-alive et reprise de session TLS. Une poignée de main TLS coûte ~6 Ko ;
549 requêtes sans réutilisation, c'est 3 Mo perdus. Marginal mais gratuit.

### 7. Préréglages de raisonnement et de groupage

Le préréglage relève le niveau d'effort et installe un style de sortie qui
pousse à grouper les appels d'outils et à préférer une commande shell composée
à cinq appels successifs. Chaque aller-retour économisé est un contexte entier
non réexpédié. Ce levier améliore la qualité en même temps qu'il réduit les
octets.

## Garde-fou

Actif par défaut, avec des seuils larges : il ne doit jamais se déclencher dans
un usage normal, seulement arrêter un emballement.

- **Avertissement de session à 500 Mo cumulés.** Une ligne, une seule fois.
- **Arrêt dur à 2 Go cumulés.** La session est close proprement, le transcript
  reste intact et reprenable par `ccl --resume`.
- **Avertissement par requête au-delà de 5 Mo.** Signale un contexte ou des
  images qui gonflent, avec la catégorie fautive nommée.

Réglable par `--cap` et `--warn`, désactivable par `--no-cap`.

Le garde-fou **ne modifie jamais la conversation**. Injecter une consigne dans
le prompt pour économiser du réseau dégraderait le raisonnement, ce qui est
l'inverse du but.

## Surface CLI

```
ccl [arguments claude...]     lance Claude Code en mode lite
ccl report                    consommation par session sur l'historique
ccl doctor                    vérifie l'environnement et les leviers actifs
```

L'affichage en cours de session tient en un fragment de statusline : `↑ 47 Mo`.
Le rapport de fin de session donne le total, la répartition par catégorie et
l'économie réalisée par rapport au trafic brut mesuré avant leviers.

## Choix technique

Node ≥ 18, **sans aucune dépendance** — `http`, `https` et `zlib` du runtime
suffisent. Un outil qui se réclame « lite » et tire deux cents paquets n'est
pas crédible, et l'absence de dépendances rend `npx claude-code-lite`
instantané. Distribution npm, plus une formule Homebrew si l'usage le justifie.

## Vérifications préalables

Deux inconnues conditionnent la conception. Elles sont levées avant toute autre
implémentation ; si l'une échoue, le design change.

1. **Claude Code fonctionne-t-il avec une authentification par abonnement quand
   `ANTHROPIC_BASE_URL` pointe vers un proxy local ?** Si l'authentification
   OAuth est refusée sur une base URL personnalisée, le proxy doit passer par
   une autre voie et toute l'architecture est à revoir.
2. **L'API accepte-t-elle `Content-Encoding: gzip` sur le corps de requête ?**
   Un test direct est non concluant : l'authentification répond avant l'analyse
   du corps, donc une clé invalide renvoie 401 dans les deux cas. À trancher
   avec une clé valide. C'est le facteur 4 à 5 sur le poste dominant.

## Tests

Volontairement minimal. Un faux serveur amont, et deux assertions :

1. La comptabilité des octets est exacte dans les deux sens.
2. Le SSE ressort non bufferisé, événement par événement.

Plus une assertion par levier : le corps transformé reste un corps de requête
valide, et l'économie annoncée correspond à l'économie mesurée.

Le reste se vérifie à l'usage réel.

## Questions ouvertes

- La formule Homebrew vaut-elle l'effort de maintenance, ou npm suffit-il ?
- Faut-il un mode `--strict` qui pousse les seuils bien plus bas pour les
  connexions mesurées, en acceptant cette fois un compromis explicite ?

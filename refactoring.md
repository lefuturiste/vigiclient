# propositions de changement par lefuturiste

avant de commencer il faut dire que ce document est juste une proposition de refactoring du code

## Objectifs/Contraintes

- Coder en Anglais
- Garder la compatibilité avec les versions précédente (garder les mêmes interfaces avec l'extérieur ect)
- Pouvoir mieux comprendre le code et le rendre plus accessible aux contributions
- Configuration plus flexible
- Constituer un module js avec une API pour pouvoir modder son robot avec un Event Listener
- Avoir des conventions
- Organiser le code dans des classes/modules

## Structure proposé

- VideoManager
- AudioManager
- ServerManager
- ConfigurationManager
- 